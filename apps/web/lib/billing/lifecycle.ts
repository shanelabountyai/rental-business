import 'server-only'

import { lifecycleDecision, requiresStripeCall } from '@rental/core/billing'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { getBillingProvider } from './provider.ts'
import { provisionLeaseBilling } from './provision.ts'
import { syncRecurringCharges } from './recurring.ts'

// Making Stripe agree with the lease (D-11, R-036).
//
// The backlog calls this "the item where D-11 actually pays off", and this
// file is the evidence: under a ledger-driven design, "the tenancy ended,
// stop billing" needs a scheduler, a calendar, a retry policy and a
// reconciliation. Here it is one decision (packages/core/billing/lifecycle)
// and one API call.
//
// ASK STRIPE, THEN DECIDE, THEN ACT - in that order, per payer. Deciding
// from our own columns alone would mean acting on what we last believed
// rather than on what is true, and the whole point of a re-sync is that the
// two have diverged. The read costs an API round trip per payer, which is
// why the sweep is bounded and the screen's re-sync is per-lease.

export type SyncOutcome =
  | 'in_sync'
  | 'provisioned'
  | 'price_updated'
  | 'paused'
  | 'resumed'
  | 'cancelled'
  | 'failed'
  /// Nothing to ask about: no subscription and none needed.
  | 'not_applicable'

export interface SyncResult {
  leasePayerId: string
  leaseId: string
  outcome: SyncOutcome
  reason: string
  error?: string
}

/**
 * Brings one payer's Stripe subscription into line with its lease.
 *
 * Never throws. A billing provider being unreachable is an operational
 * condition, not a reason to fail whatever the caller was doing - and the
 * failure is recorded on the payer so the Billing Runs screen can show it
 * rather than it living only in a log nobody reads.
 */
export async function syncLeasePayer(leasePayerId: string): Promise<SyncResult> {
  const payer = await prisma.leasePayer.findUniqueOrThrow({
    where: { id: leasePayerId },
    select: {
      id: true,
      leaseId: true,
      propertyId: true,
      stripeSubscriptionId: true,
      collectionPaused: true,
      lease: {
        select: { status: true, rentCents: true, moveOutAt: true },
      },
    },
  })

  const provider = getBillingProvider()

  try {
    // What Stripe currently believes. Null when there is nothing to ask
    // about - which the decision treats as "we have not asked", NOT as
    // "Stripe has nothing", because acting on the difference between a
    // lease and an unasked question would be acting on an assumption.
    const stripe = payer.stripeSubscriptionId
      ? await provider.getSubscription({
          stripeSubscriptionId: payer.stripeSubscriptionId,
        })
      : null

    const decision = lifecycleDecision(
      {
        status: payer.lease.status,
        rentCents: payer.lease.rentCents,
        stripeSubscriptionId: payer.stripeSubscriptionId,
        collectionPaused: payer.collectionPaused,
        moveOutAt: payer.lease.moveOutAt,
      },
      stripe,
    )

    if (!requiresStripeCall(decision)) {
      await record(payer.id, 'in_sync', null)
      return {
        leasePayerId: payer.id,
        leaseId: payer.leaseId,
        outcome: payer.stripeSubscriptionId ? 'in_sync' : 'not_applicable',
        reason: decision.reason,
      }
    }

    let outcome: SyncOutcome
    switch (decision.action) {
      case 'provision': {
        const result = await provisionLeaseBilling(payer.leaseId)
        outcome = result.outcome === 'failed' ? 'failed' : 'provisioned'
        break
      }
      case 'update_price':
        await provider.updateSubscriptionPrice({
          stripeSubscriptionId: payer.stripeSubscriptionId!,
          amountCents: payer.lease.rentCents,
          currency: 'usd',
          leaseId: payer.leaseId,
        })
        // Recorded only AFTER Stripe accepted it. Writing it first would
        // leave us believing we had pushed a change that failed.
        await prisma.leasePayer.update({
          where: { id: payer.id },
          data: { stripeAmountCents: payer.lease.rentCents },
        })
        outcome = 'price_updated'
        break
      case 'pause':
        await provider.pauseSubscription({
          stripeSubscriptionId: payer.stripeSubscriptionId!,
          // `mark_uncollectible`, not `void`: PAY-12's hold means we stop
          // COLLECTING, not that the money stops being owed. Voiding the
          // invoice would erase a debt that is still real.
          behaviour: 'mark_uncollectible',
        })
        outcome = 'paused'
        break
      case 'resume':
        await provider.resumeSubscription({
          stripeSubscriptionId: payer.stripeSubscriptionId!,
        })
        outcome = 'resumed'
        break
      case 'cancel':
        await provider.cancelSubscription({
          stripeSubscriptionId: payer.stripeSubscriptionId!,
          at: decision.effectiveAt,
        })
        await prisma.leasePayer.update({
          where: { id: payer.id },
          data: { stripeAmountCents: null },
        })
        outcome = 'cancelled'
        break
      default:
        outcome = 'in_sync'
    }

    await record(payer.id, outcome, null)
    await auditAsSystem('billing.lifecycle', {
      action: 'billing.subscription_synced',
      entityType: 'Lease',
      entityId: payer.leaseId,
      propertyId: payer.propertyId,
      after: {
        provider: provider.name,
        leasePayerId: payer.id,
        outcome,
        reason: decision.reason,
        effectiveAt: decision.effectiveAt?.toISOString() ?? null,
      },
    }).catch((error) => {
      console.error(`[billing] could not audit sync for ${payer.id}`, error)
    })

    return {
      leasePayerId: payer.id,
      leaseId: payer.leaseId,
      outcome,
      reason: decision.reason,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    console.error(`[billing] sync failed for payer ${payer.id}`, error)
    await record(payer.id, 'failed', message)
    return {
      leasePayerId: payer.id,
      leaseId: payer.leaseId,
      outcome: 'failed',
      reason: 'The billing provider could not be reached.',
      error: message,
    }
  }
}

async function record(leasePayerId: string, action: SyncOutcome, error: string | null) {
  await prisma.leasePayer.update({
    where: { id: leasePayerId },
    data: { lastSyncedAt: new Date(), lastSyncAction: action, lastSyncError: error },
  })
}

/// Every payer on one lease. What the lease page's re-sync button calls, and
/// what a lease status change triggers.
export async function syncLease(leaseId: string): Promise<SyncResult[]> {
  const payers = await prisma.leasePayer.findMany({
    where: { leaseId, active: true },
    select: { id: true },
  })
  const results: SyncResult[] = []
  for (const payer of payers) {
    results.push(await syncLeasePayer(payer.id))
  }
  return results
}

export interface BillingRunResult {
  checked: number
  changed: number
  failed: number
  results: SyncResult[]
}

/**
 * The nightly billing run.
 *
 * Bounded, and deliberately narrow about what it looks at: payers on leases
 * that are live or have just ended. A payer on a lease that ended two years
 * ago was cancelled then and asking Stripe about it every night forever is
 * an API bill for no information.
 *
 * Sequential rather than parallel. This talks to a rate-limited external
 * API, and a portfolio of 10-50 units is tens of payers - the wall-clock
 * saving from concurrency is seconds, and the cost of tripping Stripe's rate
 * limiter is a run that half-completed.
 */
export async function runBillingSweep(
  options: { limit?: number; propertyIds?: readonly string[] } = {},
): Promise<BillingRunResult> {
  const limit = options.limit ?? 200
  const payers = await prisma.leasePayer.findMany({
    where: {
      active: true,
      // Optionally one property's worth. The nightly cron passes nothing and
      // sweeps everything in scope; the Billing Runs screen can re-run a
      // single property without waiting on the whole portfolio, which is
      // also what makes this testable without syncing every payer in the
      // database.
      ...(options.propertyIds ? { propertyId: { in: [...options.propertyIds] } } : {}),
      OR: [
        { lease: { status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } } },
        // Recently ended, so a cancellation that has not landed yet still
        // gets one more chance.
        {
          lease: { status: { in: ['ENDED', 'TERMINATED'] } },
          stripeSubscriptionId: { not: null },
        },
      ],
    },
    select: { id: true, leaseId: true },
    take: limit,
    orderBy: { createdAt: 'asc' },
  })

  const results: SyncResult[] = []
  for (const payer of payers) {
    results.push(await syncLeasePayer(payer.id))
  }

  // R-042's recurring charges, on the same safety net and for the same
  // reason. `endsOn` is what makes this necessary rather than tidy: a
  // landlord who says the pet rent stops in March has said something nothing
  // else in the product would ever act on, and a fee that outlives the pet is
  // money taken from a tenant who agreed to no such thing.
  //
  // Per LEASE, not per payer - the charges hang off the tenancy, and a
  // voucher lease's two payers would otherwise run this twice.
  for (const leaseId of new Set(payers.map((payer) => payer.leaseId))) {
    await syncRecurringCharges(leaseId).catch((error: unknown) => {
      console.error(`[billing] recurring sync failed for lease ${leaseId}`, error)
    })
  }

  return {
    checked: results.length,
    changed: results.filter(
      (r) => r.outcome !== 'in_sync' && r.outcome !== 'not_applicable' && r.outcome !== 'failed',
    ).length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    results,
  }
}

/// The Billing Runs screen's own read: every payer in scope with what the
/// last sync did, worst first.
export async function billingRunRows(propertyIds: readonly string[]) {
  if (propertyIds.length === 0) return []
  const payers = await prisma.leasePayer.findMany({
    where: { propertyId: { in: [...propertyIds] }, active: true },
    select: {
      id: true,
      leaseId: true,
      stripeSubscriptionId: true,
      collectionPaused: true,
      lastSyncedAt: true,
      lastSyncAction: true,
      lastSyncError: true,
      tenant: { select: { firstName: true, lastName: true } },
      externalPayerName: true,
      lease: {
        select: {
          status: true,
          rentCents: true,
          property: { select: { name: true, timezone: true } },
          unit: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  // Failures first, then never-synced, then everything else. A screen whose
  // problems are somewhere in the middle of a list is one nobody scans.
  const rank = (row: (typeof payers)[number]) =>
    row.lastSyncError ? 0 : row.lastSyncedAt ? 2 : 1
  return payers.sort((a, b) => rank(a) - rank(b))
}
