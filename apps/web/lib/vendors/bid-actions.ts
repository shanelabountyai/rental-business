'use server'

import { validateBid } from '@rental/core/approvals'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { auditAsVendor } from '@/lib/audit/system.ts'
import { verifyBidLink } from './bids.ts'
import type { VendorFormState } from './actions.ts'

// What a vendor submits when asked to price a job (MAINT-04, R-026).
//
// Same shape and same reasoning as R-025's vendor actions: the raw token is
// the first argument and is re-verified here, because there is no session
// and a call that forgot to check it would be an unauthenticated write.

export async function submitBid(
  token: string,
  _previous: VendorFormState,
  formData: FormData,
): Promise<VendorFormState> {
  const link = await verifyBidLink(token)
  if (!link.ok) {
    return {
      error:
        link.reason === 'not_actionable'
          ? 'This job has already been assigned. Thanks for looking.'
          : 'This link is not valid. Check for a newer message, or call the office.',
    }
  }

  const { bid, vendorId } = link
  if (bid.respondedAt) {
    return { error: 'You have already given us a price for this one. Call the office to change it.' }
  }

  const declined = formData.get('declined') === 'true'
  const raw = formData.get('amountDollars')
  const amountDollars = typeof raw === 'string' ? raw.trim() : ''
  const amountCents = amountDollars ? Math.round(Number(amountDollars) * 100) : null
  const note = typeof formData.get('note') === 'string' ? String(formData.get('note')).trim() : ''

  const violations = validateBid({ amountCents, note, declined })
  if (violations.length > 0) {
    return {
      error: 'Check the amount.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
      // R-114: a refused price used to take the note with it.
      values: { amountDollars, note },
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.workOrderBid.update({
      where: { id: bid.id },
      data: {
        amountCents: declined ? null : amountCents,
        note: note || null,
        declinedAt: declined ? new Date() : null,
        respondedAt: new Date(),
      },
    })
    await auditAsVendor(
      vendorId,
      {
        action: 'workorder.bid_submitted',
        entityType: 'WorkOrderBid',
        entityId: bid.id,
        propertyId: bid.workOrder.propertyId,
        after: { amountCents: declined ? null : amountCents, declined, note: note || null },
      },
      tx,
    )
  })

  revalidatePath(`/workorders/${bid.workOrderId}`)
  return {
    notice: declined ? 'Thanks for letting us know.' : 'Thanks - we have your price.',
  }
}
