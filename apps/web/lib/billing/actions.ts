'use server'

import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { audit } from '@/lib/audit/index.ts'
import { applyPaymentHold } from '@/lib/payments/legal-hold.ts'
import { syncLease, syncLeasePayer } from './lifecycle.ts'

// Writes for the billing lifecycle (D-11, R-036).

export interface BillingFormState {
  error?: string
  notice?: string
}

/**
 * The re-sync action: ask Stripe what it believes, and make it agree.
 *
 * Gated on `ledger.read` plus the property, not on a billing-specific
 * permission - the people who can see a lease's money are the people who
 * should be able to fix its billing, and inventing a permission with one
 * consumer would be a role nobody assigns.
 */
export async function resyncPayer(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const leasePayerId = String(formData.get('leasePayerId') ?? '')
  if (!leasePayerId) return { error: 'No payer named.' }

  const payer = await prisma.leasePayer.findUniqueOrThrow({
    where: { id: leasePayerId },
    select: { property: { select: { id: true, legalEntityId: true } } },
  })
  await requirePermission('ledger.read', propertyResource(payer.property))

  const result = await syncLeasePayer(leasePayerId)

  revalidatePath('/money')
  return result.outcome === 'failed'
    ? { error: `Stripe could not be reached: ${result.error ?? 'unknown error'}` }
    : { notice: `${describe(result.outcome)} — ${result.reason}` }
}

export async function resyncLease(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  // Read from the form rather than bound, so both re-sync actions have the
  // same shape - and so neither carries a trailing parameter it never uses.
  const leaseId = String(formData.get('leaseId') ?? '')
  if (!leaseId) return { error: 'No lease named.' }

  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: { property: { select: { id: true, legalEntityId: true } } },
  })
  await requirePermission('ledger.read', propertyResource(lease.property))

  const results = await syncLease(leaseId)
  revalidatePath(`/leases/${leaseId}`)

  const failed = results.filter((r) => r.outcome === 'failed')
  if (failed.length > 0) {
    return { error: `Stripe could not be reached: ${failed[0]!.error ?? 'unknown error'}` }
  }
  return {
    notice:
      results.length === 0
        ? 'Nothing to sync — this lease has no payer yet.'
        : results.map((r) => `${describe(r.outcome)} — ${r.reason}`).join(' · '),
  }
}

/// Plain language on screen. "price_updated" is a code; "Repriced at Stripe"
/// is what somebody reading a billing screen needs.
function describe(outcome: string): string {
  const labels: Record<string, string> = {
    in_sync: 'Already in step',
    provisioned: 'Subscription opened',
    price_updated: 'Repriced at Stripe',
    paused: 'Collection paused',
    resumed: 'Collection resumed',
    cancelled: 'Subscription cancelled',
    not_applicable: 'Nothing to bill',
    failed: 'Failed',
  }
  return labels[outcome] ?? outcome
}

/**
 * PAY-12's legal-action payment controls (R-047).
 *
 * ==========================================================================
 * GATED ON `ledger.adjust`, NOT `ledger.read`.
 *
 * `resyncPayer` above runs on `ledger.read` on the reasoning that whoever can
 * see a lease's money should be able to fix its billing. That reasoning does
 * not reach here. This does not correct a discrepancy; it STOPS TAKING
 * SOMEBODY'S RENT, in support of an eviction, and getting it wrong in either
 * direction has legal consequences — a hold not applied lets a charge void a
 * notice, and a hold applied wrongly withholds a tenant's ability to cure.
 * That is the same class of judgement as a ledger adjustment, which R-004
 * reserves for `ledger.adjust` and ROLE-05 requires a proved second factor
 * for.
 * ==========================================================================
 */
export async function setPaymentHold(
  _previous: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const leasePayerId = String(formData.get('leasePayerId') ?? '')
  if (!leasePayerId) return { error: 'No payer named.' }

  const payer = await prisma.leasePayer.findUnique({
    where: { id: leasePayerId },
    select: { id: true, leaseId: true, property: { select: { id: true, legalEntityId: true } } },
  })
  if (!payer) return { error: 'That payer no longer exists.' }

  const actor = await requirePermission('ledger.adjust', propertyResource(payer.property))

  const result = await applyPaymentHold(
    payer.id,
    {
      blockOnline: formData.get('blockOnline') === 'on',
      blockPartial: formData.get('blockPartial') === 'on',
      certifiedFundsOnly: formData.get('certifiedFundsOnly') === 'on',
      reason: String(formData.get('reason') ?? ''),
    },
    actor.id,
    // The request-aware writer, which resolves the actor and their IP from
    // the session. Injected so the module itself stays loadable outside a
    // request — see `AuditWriter`.
    audit,
  )

  revalidatePath(`/leases/${payer.leaseId}`)
  revalidatePath('/money')

  if (!result.ok) return { error: result.error }
  return {
    notice:
      result.linksRevoked > 0
        ? `Saved, and confirmed with the payment provider. ${result.linksRevoked} live pay-now ${
            result.linksRevoked === 1 ? 'link was' : 'links were'
          } revoked.`
        : 'Saved, and confirmed with the payment provider.',
  }
}
