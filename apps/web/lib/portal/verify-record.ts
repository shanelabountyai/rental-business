import 'server-only'

import { type AuditInput, type AuditDb } from '@rental/core/audit'
import { validateVerification } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { readyToCloseTask, reopenWorkOrder } from '@/lib/workorders/verify.ts'

/// How this answer gets attributed. PASSED IN rather than resolved here, and
/// that is the point: the portal knows a session, the magic link knows a
/// token, and they prove who is answering in genuinely different ways.
///
/// It also keeps Auth.js out of this module. `audit()` imports `auth()`,
/// which cannot load outside a request context — so a module importing it is
/// untestable under Vitest, which is precisely how the missing attribution
/// below went unnoticed until a test tried to load this file.
export type AuditWriter = (input: Omit<AuditInput, 'actor'>, db: AuditDb) => Promise<void>

// Recording the tenant's answer (MAINT-07, R-030), independent of how they
// were identified.
//
// EXTRACTED IN R-032c because there are now two ways to answer and only one
// of them may drift. The portal action authenticates with a session; the
// magic link authenticates with a single-purpose token. Everything after
// "we know which tenant is answering which job" is identical, and a second
// copy of the status transition, the round arithmetic, the reopen clearing
// and the task fan-out is how the two answers start meaning different
// things.
//
// This function does NOT authorize. Both callers establish the tenant first
// and pass it in — the session guard on one side, the token on the other —
// because they prove it in genuinely different ways and folding that in here
// would make the check a parameter, which is the shape mistakes hide in.

export interface VerificationInput {
  resolved: boolean | undefined
  rating: number | null
  comment: string | null
}

export type VerificationOutcome =
  | { ok: true; resolved: boolean; ticketId: string | null; notice: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }
  /// Already answered this round. Not an error: a tenant tapping twice has
  /// answered once, and telling them so is better than a crash on a screen
  /// they are trying to be helpful on.
  | { ok: true; resolved: null; ticketId: string | null; notice: string }

export async function recordVerification(
  workOrderId: string,
  tenantId: string,
  input: VerificationInput,
  writeAudit: AuditWriter,
): Promise<VerificationOutcome> {
  const violations = validateVerification(input)
  if (violations.length > 0) {
    return {
      ok: false,
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

  // THEIR OWN job, or nothing — re-checked here even though both callers
  // have already established the tenant. The session path checks scope and
  // the token path checks the token's subject; this is the invariant itself,
  // and it costs one comparison to make it impossible to reach the write
  // without it. Indistinguishable responses for "not found" and "not yours",
  // like every other portal read (DOC-03).
  if (!workOrder || workOrder.ticket?.tenantId !== tenantId) {
    return { ok: false, error: 'That request could not be found.' }
  }
  if (workOrder.status !== 'WORK_COMPLETE') {
    return { ok: false, error: 'There is nothing to confirm on this request yet.' }
  }

  const round = workOrder.reopenCount + 1

  try {
    await prisma.$transaction(async (tx) => {
      await tx.workOrderVerification.create({
        data: {
          workOrderId: workOrder.id,
          tenantId,
          // WHO DID THE WORK, captured now. The work order's vendor moves
          // when a reopened job is reassigned; this row must not.
          vendorId: workOrder.vendorId,
          round,
          resolved,
          rating: input.rating,
          comment: input.comment,
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

      await writeAudit(
        {
          action: resolved ? 'workorder.verified' : 'workorder.reopened',
          entityType: 'WorkOrder',
          entityId: workOrder.id,
          propertyId: workOrder.propertyId,
          before: { status: workOrder.status },
          after: { round, resolved, rating: input.rating, vendorId: workOrder.vendorId },
        },
        tx,
      )
    })
  } catch (error) {
    // The unique index on (workOrderId, round) is the double-tap guard.
    if (isUniqueViolation(error)) {
      return {
        ok: true,
        resolved: null,
        ticketId: workOrder.ticket?.id ?? null,
        notice: 'Thanks — we have your answer.',
      }
    }
    throw error
  }

  // Outside the transaction on purpose: the answer is recorded and must not
  // be rolled back because a task write failed. A missing task is a queue gap
  // somebody notices; a lost "it is still broken" is not.
  //
  // BOTH answers raise one. A "no" is a repair to redo; a "yes" is an invoice
  // to book and a cost to record against the property.
  const task = resolved
    ? readyToCloseTask({ ...workOrder, property: workOrder.property, unit: workOrder.unit })
    : reopenWorkOrder(
        { ...workOrder, property: workOrder.property, unit: workOrder.unit },
        input.comment,
      )
  await task.catch((error) => {
    console.error(`[verify] task failed for ${workOrder.id}`, error)
  })

  return {
    ok: true,
    resolved,
    ticketId: workOrder.ticket?.id ?? null,
    notice: resolved
      ? 'Thanks — we have closed this off.'
      : 'Thanks for telling us. We have reopened it; you do not need to report it again.',
  }
}
