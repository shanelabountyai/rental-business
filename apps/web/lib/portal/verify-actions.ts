'use server'

import { validateVerification } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { readyToCloseTask, reopenWorkOrder } from '@/lib/workorders/verify.ts'

// The tenant's one tap (MAINT-07, R-030).
//
// Lives on the PORTAL side, with the portal's own guard, because the actor
// is a tenant and `requirePermission()` reads a staff session. R-018's rule,
// restated: the tenant side never falls through to the staff side.

export interface VerifyFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

export async function verifyWorkOrder(
  _previous: VerifyFormState,
  formData: FormData,
): Promise<VerifyFormState> {
  const { scope } = await requireTenantWithScope()

  const workOrderId = String(formData.get('workOrderId') ?? '')
  const answer = String(formData.get('resolved') ?? '')
  const ratingRaw = String(formData.get('rating') ?? '')
  const comment = String(formData.get('comment') ?? '').trim() || null

  const input = {
    resolved: answer === 'yes' ? true : answer === 'no' ? false : undefined,
    rating: ratingRaw ? Number(ratingRaw) : null,
    comment,
  }
  const violations = validateVerification(input)
  if (violations.length > 0) {
    return {
      error: 'We still need an answer.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }
  const resolved = input.resolved as boolean

  const workOrder = await prisma.workOrder.findUnique({
    where: { id: workOrderId },
    select: {
      id: true,
      propertyId: true,
      status: true,
      scope: true,
      priority: true,
      vendorId: true,
      reopenCount: true,
      property: { select: { timezone: true } },
      unit: { select: { name: true } },
      ticket: { select: { id: true, tenantId: true } },
    },
  })

  // THEIR OWN job, or nothing. Checked against the ticket's tenant rather
  // than the work order, because a work order has no tenant column - and a
  // wrong answer here would let one tenant rate, and reopen, another
  // tenant's repair. Indistinguishable responses for "not found" and "not
  // yours", same as every other portal read (DOC-03).
  if (!workOrder || workOrder.ticket?.tenantId !== scope.tenantId) {
    return { error: 'That request could not be found.' }
  }
  if (workOrder.status !== 'WORK_COMPLETE') {
    return { error: 'There is nothing to confirm on this request yet.' }
  }

  const round = workOrder.reopenCount + 1

  try {
    await prisma.$transaction(async (tx) => {
      await tx.workOrderVerification.create({
        data: {
          workOrderId: workOrder.id,
          tenantId: scope.tenantId,
          // WHO DID THE WORK, captured now. The work order's vendor moves
          // when a reopened job is reassigned; this row must not.
          vendorId: workOrder.vendorId,
          round,
          resolved,
          rating: input.rating,
          comment,
        },
      })

      await tx.workOrder.update({
        where: { id: workOrder.id },
        data: resolved
          ? { status: 'VERIFIED', verifiedAt: new Date() }
          : {
              status: 'SUBMITTED',
              reopenedAt: new Date(),
              reopenCount: { increment: 1 },
              // Cleared, because it is no longer true: the previous round's
              // completion has been contradicted, and leaving the stamp
              // would let a later reader believe the job was signed off.
              verifiedAt: null,
              completedAt: null,
            },
      })

      await audit(
        {
          action: resolved ? 'workorder.verified' : 'workorder.reopened',
          entityType: 'WorkOrder',
          entityId: workOrder.id,
          propertyId: workOrder.propertyId,
          before: { status: workOrder.status },
          after: {
            round,
            resolved,
            rating: input.rating,
            vendorId: workOrder.vendorId,
          },
        },
        tx,
      )
    })
  } catch (error) {
    // The unique index on (workOrderId, round) is the double-tap guard. A
    // tenant pressing twice has answered once, and being told so is better
    // than a crash on a screen they are trying to be helpful on.
    if (isUniqueViolation(error)) return { notice: 'Thanks — we have your answer.' }
    throw error
  }

  // Outside the transaction on purpose: the answer is recorded and must not
  // be rolled back because a task write failed. A missing task is a queue
  // gap somebody notices; a lost "it is still broken" is not.
  //
  // BOTH answers raise one. A "no" is a repair to redo; a "yes" is an invoice
  // to book and a cost to record against the property, and until R-037 that
  // second one was nobody's job because nothing said it existed.
  const task = resolved
    ? readyToCloseTask({ ...workOrder, property: workOrder.property, unit: workOrder.unit })
    : reopenWorkOrder(
        { ...workOrder, property: workOrder.property, unit: workOrder.unit },
        comment,
      )
  await task.catch((error) => {
    console.error(`[verify] task failed for ${workOrder.id}`, error)
  })

  revalidatePath(`/portal/maintenance/${workOrder.ticket?.id}`)
  revalidatePath('/portal/maintenance')
  return {
    notice: resolved
      ? 'Thanks — we have closed this off.'
      : 'Thanks for telling us. We have reopened it; you do not need to report it again.',
  }
}
