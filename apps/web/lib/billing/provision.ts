import 'server-only'

import { billingCycleAnchor, firstPeriodIsPartial } from '@rental/core/billing'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { chargeMoveInProration } from './proration.ts'
import { getBillingProvider } from './provider.ts'
import { syncRecurringCharges } from './recurring.ts'

// Provisioning a lease's billing (D-11, R-034).
//
// D-11: "each active lease gets a Stripe Customer, a Price at the lease's
// rent amount, and a Subscription anchored to the lease's billing day in
// property-local time."
//
// TRIGGERED BY ACTIVATION, not by lease creation. A draft lease has no
// agreed rent and possibly nobody on it; opening a Stripe subscription for
// one would start billing a tenancy that may never happen. R-033's status
// machine is what says a lease is live, and this hangs off that.
//
// EVERY STEP IS SEPARATELY RESUMABLE. Provisioning spans several calls to an
// external service, and the interesting failure is the middle one: a
// customer created, a subscription not. So each id is written to our own row
// as soon as it exists, and re-running skips whatever is already there. The
// alternative - one transaction spanning the network calls - would hold a
// database transaction open across an HTTP round trip and still lose the
// customer id if it rolled back, leaving an orphan in Stripe nobody knows
// about.

export type ProvisionOutcome =
  | 'provisioned'
  | 'already_provisioned'
  /// Nothing to bill: no payer on the lease yet.
  | 'no_payer'
  | 'failed'

export interface ProvisionResult {
  outcome: ProvisionOutcome
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  /// True when the first period is not a whole month. R-042 owns computing
  /// and pushing that amount (D-12 keeps it ours, not Stripe's proration);
  /// this only records that the question is open so a later item cannot
  /// silently skip it.
  firstPeriodPartial?: boolean
  error?: string
}

/**
 * Ensures a `LeasePayer` exists for a lease, creating the ordinary
 * single-payer one from the primary tenant if it does not.
 *
 * A voucher lease's second payer is R-048's (D-13 already gives it somewhere
 * to live); this only covers the case every tenancy has.
 */
async function ensurePayer(leaseId: string) {
  const existing = await prisma.leasePayer.findFirst({
    where: { leaseId, active: true },
    orderBy: { createdAt: 'asc' },
  })
  if (existing) return existing

  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      propertyId: true,
      leaseTenants: {
        orderBy: { isPrimary: 'desc' },
        take: 1,
        select: { tenantId: true },
      },
    },
  })
  const tenantId = lease.leaseTenants[0]?.tenantId
  if (!tenantId) return null

  return prisma.leasePayer.create({
    data: {
      leaseId,
      propertyId: lease.propertyId,
      payerType: 'TENANT',
      tenantId,
      // Null means "the remainder", which is how a single-payer lease works
      // without anybody keeping a number in sync with the rent - see the
      // column's own schema comment.
      portionCents: null,
    },
  })
}

/**
 * Opens billing for a lease that has just gone live.
 *
 * Safe to call repeatedly: an already-provisioned lease returns
 * `already_provisioned` without touching Stripe. That matters because the
 * caller is a status transition somebody can perform twice.
 */
export async function provisionLeaseBilling(
  leaseId: string,
  now = new Date(),
): Promise<ProvisionResult> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      rentCents: true,
      rentDueDay: true,
      startsOn: true,
      activatedAt: true,
      property: { select: { name: true, timezone: true } },
    },
  })

  const payer = await ensurePayer(leaseId)
  if (!payer) return { outcome: 'no_payer' }

  if (payer.stripeCustomerId && payer.stripeSubscriptionId) {
    return {
      outcome: 'already_provisioned',
      stripeCustomerId: payer.stripeCustomerId,
      stripeSubscriptionId: payer.stripeSubscriptionId,
    }
  }

  const tenant = payer.tenantId
    ? await prisma.tenant.findUnique({
        where: { id: payer.tenantId },
        select: { firstName: true, lastName: true, email: true, phone: true },
      })
    : null

  try {
    let stripeCustomerId = payer.stripeCustomerId
    if (!stripeCustomerId) {
      const customer = await getBillingProvider().createCustomer({
        leasePayerId: payer.id,
        leaseId: lease.id,
        propertyId: lease.propertyId,
        name: tenant
          ? `${tenant.firstName} ${tenant.lastName}`
          : (payer.externalPayerName ?? 'Payer'),
        email: tenant?.email ?? null,
        phone: tenant?.phone ?? null,
      })
      stripeCustomerId = customer.stripeCustomerId
      // Written the moment it exists. If the subscription call below fails,
      // a re-run reuses this customer rather than orphaning it in Stripe.
      await prisma.leasePayer.update({
        where: { id: payer.id },
        data: { stripeCustomerId },
      })
    }

    // Anchored in PROPERTY-LOCAL time (D-3, D-11). `notBefore` is the
    // activation instant, not the lease start: a lease activated late must
    // not be handed an anchor in the past, which Stripe would reject.
    const anchor = billingCycleAnchor({
      rentDueDay: lease.rentDueDay,
      timezone: lease.property.timezone,
      notBefore: lease.activatedAt ?? now,
    })

    const subscription = await getBillingProvider().createSubscription({
      stripeCustomerId,
      // D-12: core decides the amount, Stripe executes it.
      amountCents: lease.rentCents,
      currency: 'usd',
      billingCycleAnchor: anchor,
      leaseId: lease.id,
      leasePayerId: payer.id,
      // Whatever the payer row already says (D-29). A payer provisioned for
      // the first time carries the schema default of autopay; one being
      // RE-provisioned after a cancelled subscription keeps the mode
      // somebody deliberately put them on, rather than being silently
      // returned to autopay - which for a tenant on a payment plan would
      // start debiting an account they had asked us to stop debiting.
      collectionMethod: payer.collectionMethod,
    })

    await prisma.leasePayer.update({
      where: { id: payer.id },
      data: {
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        // What we told Stripe. See the column's own comment for why this is
        // a record of the instruction rather than a copy of Stripe's truth.
        stripeAmountCents: lease.rentCents,
      },
    })

    const partial = firstPeriodIsPartial({
      startsOn: lease.startsOn,
      rentDueDay: lease.rentDueDay,
      timezone: lease.property.timezone,
    })

    await auditAsSystem('billing.provision', {
      action: 'billing.provisioned',
      entityType: 'Lease',
      entityId: lease.id,
      propertyId: lease.propertyId,
      after: {
        provider: getBillingProvider().name,
        leasePayerId: payer.id,
        stripeCustomerId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        stripePriceId: subscription.stripePriceId,
        billingCycleAnchor: anchor.toISOString(),
        amountCents: lease.rentCents,
        firstPeriodPartial: partial,
      },
    })

    // The part month, now that there is a customer to bill it to (R-042).
    // AFTER the audit above, so provisioning is on the record even if the
    // proration push fails - and never throwing, for the same reason nothing
    // else in this function does: activation is a tenancy fact and must not
    // be undone because a billing provider was unreachable.
    if (partial) {
      await chargeMoveInProration(lease.id).catch((error: unknown) => {
        console.error(`[billing] proration failed for lease ${lease.id}`, error)
      })
    }

    // Pet rent and flat utility fees agreed before billing existed (R-042).
    // A charge added to a DRAFT lease has nowhere to go until there is a
    // subscription; this is where it lands. Same posture as the proration
    // above - never thrown, because activation is a tenancy fact.
    await syncRecurringCharges(lease.id).catch((error: unknown) => {
      console.error(`[billing] recurring charges failed for lease ${lease.id}`, error)
    })

    return {
      outcome: 'provisioned',
      stripeCustomerId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      firstPeriodPartial: partial,
    }
  } catch (error) {
    // Never rethrown into the caller. Activation is a tenancy fact and must
    // not be undone because a billing provider was unreachable - the lease
    // IS live, and re-running this is how billing catches up.
    console.error(`[billing] could not provision lease ${leaseId}`, error)
    return {
      outcome: 'failed',
      error: error instanceof Error ? error.message : 'unknown error',
    }
  }
}

/// A SetupIntent for saving a payment method (PAY-02). Stripe-hosted fields
/// only - this hands back a client secret and no card or bank number ever
/// reaches this product.
export async function createPaymentMethodSetup(leasePayerId: string) {
  const payer = await prisma.leasePayer.findUniqueOrThrow({
    where: { id: leasePayerId },
    select: { stripeCustomerId: true },
  })
  if (!payer.stripeCustomerId) return null
  return getBillingProvider().createSetupIntent(payer.stripeCustomerId)
}

/// The billing state of a lease, for display. Reads our own rows rather than
/// asking Stripe: a screen that made a network call per lease would be slow
/// and would show a different answer than the projection does.
export async function leaseBillingState(leaseId: string) {
  return prisma.leasePayer.findMany({
    where: { leaseId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      payerType: true,
      portionCents: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      active: true,
      // R-143: the lease page shows how each payer is collected from, and
      // offers the D-29 switch. Read here rather than in a second query, the
      // same reason the hold columns below are.
      collectionMethod: true,
      tenant: { select: { firstName: true, lastName: true } },
      externalPayerName: true,
      // PAY-12's legal-action controls (R-047), read here so the lease page
      // can show a held tenancy without a second query.
      collectionPaused: true,
      blockPartialPayments: true,
      certifiedFundsOnly: true,
      paymentHoldReason: true,
      paymentHoldSetAt: true,
      paymentHoldSetBy: { select: { name: true } },
    },
  })
}
