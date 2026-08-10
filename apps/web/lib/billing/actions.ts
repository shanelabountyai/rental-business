'use server'

import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
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
