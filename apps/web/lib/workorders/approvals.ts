'use server'

import {
  actualTotalCents,
  approvalRequirement,
  approvalRoute,
  reapprovalCheck,
  validateApprovalDecision,
} from '@rental/core/approvals'
import { type Priority, prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import {
  propertyResource,
  requireMonetaryAuthority,
  requirePermission,
} from '@/lib/auth/guard.ts'
import { completeTaskWork } from '@/lib/tasks/complete.ts'
import { createTask } from '@/lib/tasks/create.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { issueBidLink } from '@/lib/vendors/bids.ts'
import { businessDate } from '@rental/core/scheduling'
import { policyFor } from './queries.ts'
import type { WorkOrderFormState } from './actions.ts'

// Approval thresholds (MAINT-04, ROLE-02, R-026).
//
// R-004 built `checkMonetaryAuthority()` and `requireMonetaryAuthority()` and
// left them without a caller, with a comment saying the caller's job is to
// "create that approval" rather than treat over-ceiling as a failure. This
// file is that caller.
//
// The whole flow in one place, because it is one decision with three
// possible destinations: dispatch, sign it yourself, or send it up.

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/// Raises the approval into the ONE staff queue (D-9). A pending approval is
/// work somebody has to do, and MAINT-04's "the owner can Approve/Deny/Ask
/// from phone in <=2 taps" is a queue item on a phone, not an email nobody
/// opens. Idempotent per (work order, day) through createTask's own key.
async function raiseApprovalTask(workOrder: {
  id: string
  propertyId: string
  scope: string
  priority: Priority
  estimateCents: number | null
  property: { timezone: string }
}) {
  const dollars =
    workOrder.estimateCents != null
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
          workOrder.estimateCents / 100,
        )
      : 'no estimate'
  await createTask(prisma, {
    propertyId: workOrder.propertyId,
    type: 'workorder_approval',
    subjectType: 'WorkOrder',
    subjectId: workOrder.id,
    businessDate: businessDate(new Date(), workOrder.property.timezone),
    priority: workOrder.priority,
    title: `Approve ${dollars}: ${workOrder.scope.slice(0, 50)}`,
  })
}

/**
 * Sends a work order for approval if its estimate is over the entity's
 * threshold, or approves it on the spot if the actor's own ceiling covers
 * it (MAINT-04, ROLE-02).
 *
 * Called by a PM who is ready to dispatch. The three outcomes are the three
 * routes in `approvalRoute()`, and which one fires is not this function's
 * decision to make - it asks core and does what it is told.
 */
export async function submitForApproval(
  workOrderId: string,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { property: true },
  })
  await requirePermission('workorder.write', propertyResource(workOrder.property))

  if (workOrder.status === 'CLOSED' || workOrder.status === 'CANCELED') {
    return { error: 'This work order is already resolved.' }
  }

  const policy = await policyFor(workOrder.propertyId)
  const requirement = approvalRequirement(workOrder.estimateCents, policy)

  // The amount the AUTHORITY question is asked about. Zero when there is no
  // estimate, which never reaches checkMonetaryAuthority anyway because
  // approvalRequirement() already said no approval is needed.
  const amountCents = workOrder.estimateCents ?? 0
  const { actor, decision } = await requireMonetaryAuthority('approve_work_order', amountCents)
  const route = approvalRoute(requirement.outcome === 'required', decision)

  switch (route.route) {
    case 'no_approval_needed':
      return { notice: 'Under the approval threshold - go ahead and dispatch.' }

    case 'not_permitted':
      return {
        error:
          'You cannot approve work orders. Ask a manager or the owner to submit this one.',
      }

    case 'self_approve':
      await recordDecision(workOrder, actor.id, 'APPROVE', {
        approvedAmountCents: amountCents,
        selfApproved: true,
      })
      revalidatePath(`/workorders/${workOrderId}`)
      return { notice: 'Approved - within your own ceiling.' }

    case 'escalate': {
      await prisma.$transaction(async (tx) => {
        await tx.workOrder.update({
          where: { id: workOrderId },
          data: { status: 'PENDING_APPROVAL', approvalQuestion: null, denialReason: null },
        })
        await audit(
          {
            action: 'workorder.approval_requested',
            entityType: 'WorkOrder',
            entityId: workOrderId,
            propertyId: workOrder.propertyId,
            before: { status: workOrder.status },
            after: {
              status: 'PENDING_APPROVAL',
              estimateCents: workOrder.estimateCents,
              // WHY it went up, recorded at the moment it did: the requester's
              // own ceiling. Reconstructing this later would mean knowing what
              // their ceiling was that day, and ceilings change.
              requesterCeilingCents: route.ceilingCents,
              thresholdCents: policy.thresholdCents,
              bidsExpected: requirement.outcome === 'required' && 'bidsExpected' in requirement,
            },
          },
          tx,
        )
      })
      await raiseApprovalTask(workOrder)
      revalidatePath(`/workorders/${workOrderId}`)
      revalidatePath('/tasks')
      return {
        notice: `Over your ceiling - sent up for approval.${
          requirement.outcome === 'required' && 'bidsExpected' in requirement
            ? ' This one is large enough that competing bids are expected.'
            : ''
        }`,
      }
    }
  }
}

/// The write half of every decision, so approve-on-the-spot and
/// approve-from-the-queue cannot drift apart.
async function recordDecision(
  workOrder: { id: string; propertyId: string; status: string; approvedAmountCents: number | null },
  actorId: string,
  decision: 'APPROVE' | 'DENY' | 'ASK',
  options: {
    approvedAmountCents?: number
    denialReason?: string
    question?: string
    selfApproved?: boolean
  } = {},
) {
  await prisma.$transaction(async (tx) => {
    if (decision === 'APPROVE') {
      await tx.workOrder.update({
        where: { id: workOrder.id },
        data: {
          status: 'APPROVED',
          approvedByStaffId: actorId,
          approvedAt: new Date(),
          approvedAmountCents: options.approvedAmountCents ?? null,
          denialReason: null,
          approvalQuestion: null,
        },
      })
    } else if (decision === 'DENY') {
      await tx.workOrder.update({
        where: { id: workOrder.id },
        data: {
          // CANCELED, not left pending: a denied work order is not going to
          // happen, and leaving it in the queue as "pending" would have the
          // PM waiting for an answer that has already been given. Re-scoping
          // it is a NEW work order, which is also the honest record - the
          // thing the owner said no to is not the thing that gets done.
          status: 'CANCELED',
          denialReason: options.denialReason ?? null,
          approvalQuestion: null,
        },
      })
    } else {
      // ASK leaves it PENDING_APPROVAL - the question is not an answer, and
      // the work order is still waiting on exactly the same decision.
      await tx.workOrder.update({
        where: { id: workOrder.id },
        data: { approvalQuestion: options.question ?? null },
      })
    }

    // A decided approval is a finished piece of work: close its queue item in
    // the same transaction. ASK does NOT close it - the question is not an
    // answer, and the approval is still owed.
    if (decision !== 'ASK') {
      const openTask = await tx.task.findFirst({
        where: { type: 'workorder_approval', subjectId: workOrder.id, status: 'OPEN' },
      })
      if (openTask) {
        await completeTaskWork(tx, openTask, actorId, { decision })
      }
    }

    await audit(
      {
        action:
          decision === 'APPROVE'
            ? 'workorder.approved'
            : decision === 'DENY'
              ? 'workorder.denied'
              : 'workorder.approval_asked',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        propertyId: workOrder.propertyId,
        before: {
          status: workOrder.status,
          approvedAmountCents: workOrder.approvedAmountCents,
        },
        after: {
          decision,
          approvedAmountCents: options.approvedAmountCents ?? null,
          selfApproved: options.selfApproved === true,
          question: options.question ?? null,
        },
        // workorder.denied is in REASON_REQUIRED (packages/core/audit), so
        // recordAudit() throws without this - the reason is not optional
        // decoration, it is enforced at the writer.
        ...(decision === 'DENY'
          ? { reasonCode: 'owner_directive' as const, reason: options.denialReason ?? '' }
          : {}),
      },
      tx,
    )
  })
}

/**
 * The owner's two-tap decision (MAINT-04): approve, deny with a reason, or
 * ask a question back.
 *
 * Re-checks the DECIDER's own ceiling, not the requester's. The point of
 * routing up is that somebody with more authority looks at it; letting the
 * queue item be actioned by anyone who can see it would make the ceiling
 * decorative.
 */
export async function decideApproval(
  workOrderId: string,
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { property: true },
  })
  await requirePermission('workorder.approve', propertyResource(workOrder.property))

  if (workOrder.status !== 'PENDING_APPROVAL') {
    return { error: 'This work order is not waiting for a decision.' }
  }

  const input = {
    decision: str(formData, 'decision'),
    denialReason: str(formData, 'denialReason') || null,
    question: str(formData, 'question') || null,
  }
  const violations = validateApprovalDecision(input)
  if (violations.length > 0) {
    return {
      error: 'Check the highlighted field.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  // The amount under discussion is whatever is on the table now: the current
  // estimate, or - when this came back for re-approval - what has actually
  // been spent, which is the bigger and more honest number to be asked about.
  const spent = actualTotalCents(workOrder)
  const amountCents = Math.max(workOrder.estimateCents ?? 0, spent ?? 0)

  if (input.decision === 'APPROVE') {
    const { actor, decision } = await requireMonetaryAuthority('approve_work_order', amountCents)
    if (decision.outcome !== 'allowed') {
      // The whole reason the ceiling exists. Somebody without enough
      // authority opening the queue item must not be able to clear it.
      return {
        error:
          decision.outcome === 'escalate'
            ? `This is over your own approval ceiling. It needs somebody with more authority.`
            : 'You cannot approve work orders.',
      }
    }
    await recordDecision(workOrder, actor.id, 'APPROVE', { approvedAmountCents: amountCents })
  } else {
    const { actor } = await requireMonetaryAuthority('approve_work_order', amountCents)
    // Denying and asking need no ceiling: saying "no" or "tell me more" to a
    // spend you cannot personally authorize is always safe, and requiring
    // authority to REFUSE would be backwards.
    await recordDecision(workOrder, actor.id, input.decision === 'DENY' ? 'DENY' : 'ASK', {
      denialReason: input.denialReason ?? undefined,
      question: input.question ?? undefined,
    })
  }

  revalidatePath(`/workorders/${workOrderId}`)
  revalidatePath('/tasks')
  return {
    notice:
      input.decision === 'APPROVE'
        ? 'Approved.'
        : input.decision === 'DENY'
          ? 'Denied - the work order has been canceled.'
          : 'Question sent back.',
  }
}

/**
 * Records what the job actually cost, and sends it back for re-approval if
 * it ran past the tolerance (MAINT-04's third criterion).
 *
 * The check runs HERE rather than at closing time because the point is to
 * catch the overrun while somebody still remembers why it happened - and
 * because R-030's close flow should not be the first place anyone notices
 * the bill doubled.
 */
export async function recordActuals(
  workOrderId: string,
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { property: true },
  })
  await requirePermission('workorder.write', propertyResource(workOrder.property))

  const laborDollars = str(formData, 'actualLaborDollars')
  const materialsDollars = str(formData, 'actualMaterialsDollars')
  const actualLaborCents = laborDollars ? Math.round(Number(laborDollars) * 100) : null
  const actualMaterialsCents = materialsDollars
    ? Math.round(Number(materialsDollars) * 100)
    : null

  for (const [field, value] of [
    ['actualLaborDollars', actualLaborCents],
    ['actualMaterialsDollars', actualMaterialsCents],
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 0)) {
      return {
        error: 'Check the amounts.',
        fieldErrors: { [field]: 'Enter a whole-dollar amount of $0 or more.' },
      }
    }
  }

  const policy = await policyFor(workOrder.propertyId)
  const updated = {
    actualLaborCents: actualLaborCents ?? workOrder.actualLaborCents,
    actualMaterialsCents: actualMaterialsCents ?? workOrder.actualMaterialsCents,
    invoiceCents: workOrder.invoiceCents,
  }
  const verdict = reapprovalCheck(
    workOrder.approvedAmountCents,
    actualTotalCents(updated),
    policy,
  )

  await prisma.$transaction(async (tx) => {
    await tx.workOrder.update({
      where: { id: workOrderId },
      data: {
        actualLaborCents: updated.actualLaborCents,
        actualMaterialsCents: updated.actualMaterialsCents,
        ...(verdict.outcome === 'reapproval_required'
          ? { status: 'PENDING_APPROVAL' as const, approvalQuestion: null }
          : {}),
      },
    })
    if (verdict.outcome === 'reapproval_required') {
      await audit(
        {
          action: 'workorder.approval_requested',
          entityType: 'WorkOrder',
          entityId: workOrderId,
          propertyId: workOrder.propertyId,
          before: { status: workOrder.status },
          after: {
            status: 'PENDING_APPROVAL',
            reason: 'actuals_over_tolerance',
            approvedCents: verdict.approvedCents,
            actualCents: verdict.actualCents,
            allowedCents: verdict.allowedCents,
          },
        },
        tx,
      )
    }
  })

  if (verdict.outcome === 'reapproval_required') {
    await raiseApprovalTask(workOrder)
    revalidatePath('/tasks')
  }
  revalidatePath(`/workorders/${workOrderId}`)

  return {
    notice:
      verdict.outcome === 'reapproval_required'
        ? 'Recorded - this ran past the approved amount, so it has gone back for re-approval.'
        : 'Recorded.',
  }
}

// ---------------------------------------------------------------------------
// Bid collection (MAINT-04's fourth criterion, R-026)
// ---------------------------------------------------------------------------

/**
 * Asks a set of vendors to price the job (MAINT-04: "sends scope + photos to
 * selected vendors and compares responses in one view").
 *
 * Creates a WorkOrderBid row per vendor at REQUEST time, not at reply time,
 * so "who was asked and never answered" is answerable - which is half of
 * what a comparison is for. Each vendor gets their own link (see
 * lib/vendors/bids.ts for why that needs its own token purpose).
 *
 * Idempotent per vendor: asking the same vendor twice re-issues their link
 * and leaves the other bidders' links alone.
 */
export async function requestBids(
  workOrderId: string,
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { property: true, unit: true },
  })
  await requirePermission('workorder.write', propertyResource(workOrder.property))

  const vendorIds = formData.getAll('vendorIds').filter((v): v is string => typeof v === 'string')
  if (vendorIds.length === 0) return { error: 'Choose at least one vendor to ask.' }

  const vendors = await prisma.vendor.findMany({
    where: { id: { in: vendorIds }, active: true },
  })
  if (vendors.length === 0) return { error: 'Those vendors could not be found.' }

  const bidDeliveryIds: string[] = []
  for (const vendor of vendors) {
    // upsert, not create: re-asking a vendor updates their existing row
    // rather than colliding on the (workOrder, vendor) unique index.
    await prisma.workOrderBid.upsert({
      where: { workOrderId_vendorId: { workOrderId, vendorId: vendor.id } },
      create: { workOrderId, vendorId: vendor.id },
      update: { requestedAt: new Date() },
    })
    const { token } = await issueBidLink(workOrderId, vendor.id)
    const link = `${process.env.AUTH_URL ?? ''}/vendor/bid/${token}`

    try {
      const outcomes = await notify({
        category: 'work_order_assigned',
        templateKey: 'workorder.bid_request',
        recipient: {
          type: 'VENDOR',
          id: vendor.id,
          email: vendor.email,
          phone: vendor.phone,
        },
        context: {
          vendorName: vendor.name,
          scope: workOrder.scope,
          addressLine1: workOrder.property.addressLine1,
          unitName: workOrder.unit.name,
          link,
        },
        propertyId: workOrder.propertyId,
        idempotencyKey: `bid-request:${workOrderId}:${vendor.id}:${token.slice(0, 8)}`,
      })
      for (const outcome of outcomes) {
        if (outcome.deliveryId) bidDeliveryIds.push(outcome.deliveryId)
      }
    } catch (error) {
      console.error(`[bids] failed to send bid request to ${vendor.id}`, error)
    }
  }
  // Only the bid requests just recorded - see the emergency page's own
  // comment for why an unscoped sweep here is a bug rather than a shortcut.
  await dispatchPendingNotifications(new Date(), 100, { deliveryIds: bidDeliveryIds }).catch(
    () => {},
  )

  await audit({
    action: 'workorder.bids_requested',
    entityType: 'WorkOrder',
    entityId: workOrderId,
    propertyId: workOrder.propertyId,
    after: { vendorIds: vendors.map((v) => v.id), vendorNames: vendors.map((v) => v.name) },
  })

  revalidatePath(`/workorders/${workOrderId}`)
  return { notice: `Asked ${vendors.length} vendor${vendors.length === 1 ? '' : 's'} to price this.` }
}
