'use server'

import { actualTotalCents, reapprovalCheck } from '@rental/core/approvals'
import { type OutboundChannel, isOpenTicketStatus, validateOutboundMessage } from '@rental/core/comms'
import { formatCents } from '@rental/core/money'
import { businessDate } from '@rental/core/scheduling'
import {
  type WorkOrderInput,
  closeDecision,
  jobCostCents,
  validateAssignment,
  validateWorkOrder,
} from '@rental/core/workorders'
import { type Prisma, prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { resolveThread } from '@/lib/comms/threads.ts'
import { sendThreadMessage } from '@/lib/comms/messages.ts'
import { emitEvent } from '@/lib/jobs/outbox.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { completeTaskWork } from '@/lib/tasks/complete.ts'
import { createTask } from '@/lib/tasks/create.ts'
import { issueVendorLink, revokeVendorLinks } from '@/lib/vendors/link.ts'
import { policyFor } from './queries.ts'
import { vendorWorkOrderThread } from './timeline.ts'
import { requestVerification } from './verify.ts'

// Writes for work orders (MAINT-03, PROP-06, R-024). Same shape as every
// other lib/*/actions.ts write in this repo: a resource-carrying permission
// check first, then a transaction pairing the write with its audit entry.

export interface WorkOrderFormState {
  error?: string
  fieldErrors?: Record<string, string>
  /// A success message worth showing. Distinct from `error` so
  /// components/auth-form.tsx's FormAlerts renders it with role="status"
  /// (polite) rather than role="alert" - "link sent" is a confirmation, not
  /// a failure the user has to act on.
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function optionalNumber(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  return raw ? Number(raw) : null
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): WorkOrderFormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

/**
 * Creates a work order, from a ticket or standalone (MAINT-03's own
 * example: a make-ready turn has no ticket behind it). When `ticketId` is
 * given, the ticket's own status moves to CONVERTED in the same
 * transaction - R-023's "Convert to work order" triage resolution names
 * this item as where dispatch itself ships, and this is that: the ticket's
 * triage decision and the work order's existence become true together, not
 * as two separate steps a PM could leave half-done.
 */
export async function createWorkOrder(
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  const ticketId = str(formData, 'ticketId') || null

  // The ticket, when there is one, is the source of truth for property and
  // unit - not a second, separately-submitted pair that could disagree with
  // it. A standalone work order (no ticket) submits unitId directly instead.
  let ticket: Awaited<ReturnType<typeof prisma.ticket.findUnique>> = null
  let propertyId: string
  let unitId: string
  if (ticketId) {
    ticket = await prisma.ticket.findUnique({ where: { id: ticketId } })
    if (!ticket) return { error: 'That ticket could not be found.' }
    propertyId = ticket.propertyId
    unitId = ticket.unitId
  } else {
    unitId = str(formData, 'unitId')
    if (!unitId) return { error: 'Choose a unit.' }
    const unit = await prisma.unit.findUnique({ where: { id: unitId } })
    if (!unit) return { error: 'That unit could not be found.' }
    propertyId = unit.propertyId
  }

  const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } })
  const actor = await requirePermission('workorder.write', propertyResource(property))

  // LEASE-12 (R-072): a turnover's punch list adds a work order through
  // this same form, from the unit page rather than /workorders/new -
  // `turnoverProjectId` is a hidden field there, never user-typed.
  const turnoverProjectId = str(formData, 'turnoverProjectId') || null
  const turnoverStage = str(formData, 'turnoverStage') || null

  const input: WorkOrderInput = {
    propertyId,
    unitId,
    ticketId,
    scope: str(formData, 'scope'),
    priority: str(formData, 'priority'),
    estimateCents: (() => {
      const dollars = optionalNumber(formData, 'estimateDollars')
      return dollars != null ? Math.round(dollars * 100) : null
    })(),
    entryPermission: formData.get('entryPermission') === 'true',
    petWarning: formData.get('petWarning') === 'true',
    warrantyClaim: formData.get('warrantyClaim') === 'true',
    turnoverProjectId,
    turnoverStage,
  }
  const violations = validateWorkOrder(input)
  if (violations.length > 0) return violationsToState(violations)

  const workOrder = await prisma.$transaction(async (tx) => {
    const created = await tx.workOrder.create({
      data: {
        propertyId,
        unitId,
        ticketId,
        scope: input.scope,
        priority: input.priority as never,
        estimateCents: input.estimateCents,
        warrantyClaim: input.warrantyClaim === true,
        turnoverProjectId,
        turnoverStage: turnoverStage as never,
      },
    })
    await audit(
      {
        action: 'workorder.created',
        entityType: 'WorkOrder',
        entityId: created.id,
        propertyId,
        after: {
          scope: created.scope,
          priority: created.priority,
          estimateCents: created.estimateCents,
          ticketId,
        },
      },
      tx,
    )
    if (ticket) {
      await tx.ticket.update({ where: { id: ticket.id }, data: { status: 'CONVERTED' } })
      await audit(
        {
          action: 'ticket.triaged',
          entityType: 'Ticket',
          entityId: ticket.id,
          propertyId,
          before: { status: ticket.status },
          after: { status: 'CONVERTED', workOrderId: created.id },
        },
        tx,
      )
      // A PM can reach this form directly, without first clicking R-023's
      // own "Convert to work order" triage resolution - if that ticket's
      // triage Task is still open, this work order existing IS that
      // decision, and leaving the Task open would strand it in the queue
      // for a ticket that no longer needs triaging.
      const openTriageTask = await tx.task.findFirst({
        where: { type: 'ticket_triage', subjectId: ticket.id, status: 'OPEN' },
      })
      if (openTriageTask) {
        await completeTaskWork(tx, openTriageTask, actor.id, {
          resolution: 'converted',
          workOrderId: created.id,
        })
      }
    }
    return created
  })

  revalidatePath('/workorders')
  if (ticketId) revalidatePath(`/maintenance/${ticketId}`)
  // Back to the unit page, not /workorders/[id]: a punch-list line is
  // triaged from the turnover panel it was added on, the same "stay where
  // you started" call the renewal and renter-insurance panels already make.
  if (turnoverProjectId) redirect(`/properties/${propertyId}/units/${unitId}`)
  redirect(`/workorders/${workOrder.id}`)
}

/**
 * Assigns to exactly one of a staff member or a vendor (MAINT-03's
 * either/or). A staff assignment emits `workorder.assigned`, which
 * job-consumer.ts turns into a Task in the ONE staff queue (D-9) - the "full
 * context" mobile job list MAINT-03 asks for. A vendor assignment does not:
 * a vendor has no login (D-6) and nothing to claim from a queue built for
 * staff; R-025's own magic link is what actually reaches them.
 */
export async function assignWorkOrder(
  workOrderId: string,
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { property: true },
  })
  await requirePermission('workorder.write', propertyResource(workOrder.property))

  const assignedStaffId = str(formData, 'assignedStaffId') || null
  const vendorId = str(formData, 'vendorId') || null
  const violations = validateAssignment({ assignedStaffId, vendorId })
  if (violations.length > 0) return violationsToState(violations)

  if (assignedStaffId) {
    const staff = await prisma.staffUser.findUnique({ where: { id: assignedStaffId } })
    if (!staff || !staff.active) return { error: 'That staff member could not be found.' }
  } else if (vendorId) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } })
    if (!vendor || !vendor.active) return { error: 'That vendor could not be found.' }
  }

  // Reassignment KILLS the previous vendor's link before anything else
  // (R-025, D-16). `vendorLinkAccess()` would refuse the old token anyway by
  // comparing it against whoever the work order now names - this is the
  // second lock on the same door, and the one that holds if that comparison
  // is ever refactored wrong. Cheap, and the thing it protects is a live
  // gate code sitting in a fired vendor's text messages.
  if (workOrder.vendorId && workOrder.vendorId !== vendorId) {
    await revokeVendorLinks(workOrderId)
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.workOrder.update({
      where: { id: workOrderId },
      data: {
        assignedStaffId,
        vendorId,
        status: 'ASSIGNED',
        // A new vendor has not answered, and has not been sent anything yet.
        // Leaving the old vendor's response here would make the queue read
        // as "accepted" for somebody who never saw it, and would stop the
        // no-response timer from ever firing for the new one.
        vendorResponse: null,
        vendorRespondedAt: null,
        vendorDeclineReason: null,
        dispatchedAt: null,
      },
    })
    await audit(
      {
        action: 'workorder.assigned',
        entityType: 'WorkOrder',
        entityId: workOrderId,
        propertyId: workOrder.propertyId,
        before: { assignedStaffId: workOrder.assignedStaffId, vendorId: workOrder.vendorId },
        after: { assignedStaffId, vendorId },
      },
      tx,
    )
    if (assignedStaffId) {
      await emitEvent(tx, {
        type: 'workorder.assigned',
        aggregateType: 'WorkOrder',
        aggregateId: workOrderId,
        propertyId: workOrder.propertyId,
        payload: { assignedStaffId },
      })
    }
    return updated
  })

  revalidatePath(`/workorders/${workOrderId}`)
  revalidatePath('/workorders')
  return {}
}

/**
 * Puts a work order on hold for a home-warranty claim, or resumes it -
 * MAINT-03's "warranty claim pending state so the tenant sees progress, not
 * silence." Resuming returns to SUBMITTED deliberately, not to whatever
 * status preceded the hold: a claim that comes back denied or resolved is a
 * work order re-entering ordinary triage, not a work order picking up
 * exactly where a since-stale assignment left off.
 */
export async function setWorkOrderWarrantyHold(
  workOrderId: string,
  onHold: boolean,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { property: true },
  })
  await requirePermission('workorder.write', propertyResource(workOrder.property))

  if (workOrder.status === 'CLOSED' || workOrder.status === 'CANCELED') {
    return { error: 'This work order is already resolved.' }
  }
  if (onHold && workOrder.status === 'ON_HOLD_WARRANTY') return {}
  if (!onHold && workOrder.status !== 'ON_HOLD_WARRANTY') return {}

  await prisma.$transaction(async (tx) => {
    const updated = await tx.workOrder.update({
      where: { id: workOrderId },
      data: {
        status: onHold ? 'ON_HOLD_WARRANTY' : 'SUBMITTED',
        warrantyClaim: onHold ? true : workOrder.warrantyClaim,
      },
    })
    await audit(
      {
        action: 'workorder.warranty_hold_set',
        entityType: 'WorkOrder',
        entityId: workOrderId,
        propertyId: workOrder.propertyId,
        before: { status: workOrder.status },
        after: { status: updated.status },
      },
      tx,
    )
  })

  revalidatePath(`/workorders/${workOrderId}`)
  return {}
}

// ---------------------------------------------------------------------------
// Vendor dispatch (MAINT-03, D-6, D-16, R-025)
// ---------------------------------------------------------------------------

/**
 * Sends the vendor their magic link, or resends it.
 *
 * RESENDING IS ALSO REVOKING: `issueVendorLink()` burns every earlier token
 * for this work order before minting the new one, so a work order has at
 * most one live link at a time. That is the documented way to kill a link
 * texted to the wrong number (D-16's control set), which is why "Resend" is
 * the same button rather than a separate destructive one nobody would think
 * to press.
 *
 * `dispatchedAt` is reset on every send, because the no-response timer
 * measures silence since the most recent ask - a vendor who ignored the
 * first text has not been silent for two days when you have only just sent
 * the second.
 *
 * Sent inline (notify + dispatchPendingNotifications in the same request)
 * rather than through the hourly outbox, for the same reason R-020's
 * emergency page is: a PM clicks "send" while deciding who is going, and an
 * hour of latency would have them phoning the vendor to ask whether the text
 * arrived. Wrapped so a provider failure cannot fail the dispatch itself -
 * the link exists and is valid whether or not the message went out, and the
 * PM can resend.
 */
/// Takes no `previous` state: useActionState calls this with (state,
/// formData) and TypeScript allows a callback declaring fewer parameters -
/// the same shape claimTask() already documents in lib/tasks/actions.ts.
export async function dispatchToVendor(
  workOrderId: string,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { property: true, unit: true, vendor: true },
  })
  await requirePermission('workorder.write', propertyResource(workOrder.property))

  if (!workOrder.vendorId || !workOrder.vendor) {
    return { error: 'Assign this to a vendor first.' }
  }
  if (workOrder.status === 'CLOSED' || workOrder.status === 'CANCELED') {
    return { error: 'This work order is already resolved.' }
  }

  const { token, expiresAt } = await issueVendorLink(workOrder.id, workOrder.vendorId)
  const link = `${process.env.AUTH_URL ?? ''}/vendor/${token}`

  await prisma.$transaction(async (tx) => {
    await tx.workOrder.update({
      where: { id: workOrder.id },
      data: { dispatchedAt: new Date(), status: 'ASSIGNED' },
    })
    await audit(
      {
        action: 'workorder.dispatched',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        propertyId: workOrder.propertyId,
        after: {
          vendorId: workOrder.vendorId,
          vendorName: workOrder.vendor!.name,
          expiresAt: expiresAt.toISOString(),
          // The TOKEN never goes in the audit trail - it is a live
          // credential, and an audit log is read by more people than a
          // credential store should be. That a link was issued, to whom, and
          // when it dies is the auditable fact; its value is not.
          resend: workOrder.dispatchedAt != null,
        },
      },
      tx,
    )
  })

  try {
    const outcomes = await notify({
      category: 'work_order_assigned',
      templateKey: 'workorder.vendor_dispatch',
      recipient: {
        type: 'VENDOR',
        id: workOrder.vendorId,
        email: workOrder.vendor.email,
        phone: workOrder.vendor.phone,
      },
      context: {
        vendorName: workOrder.vendor.name,
        scope: workOrder.scope,
        addressLine1: workOrder.property.addressLine1,
        unitName: workOrder.unit.name,
        priority: workOrder.priority,
        link,
      },
      propertyId: workOrder.propertyId,
      // Keyed on the TOKEN's own expiry, not on the work order alone: a
      // resend is a genuinely new message that must actually go out, and a
      // key of just the work order id would make the engine swallow every
      // resend after the first as a duplicate.
      idempotencyKey: `vendor-dispatch:${workOrder.id}:${expiresAt.getTime()}`,
    })
    // Scoped to this vendor's own message - an unscoped sweep would make a
    // PM clicking "send" pay for the entire global queue, and could send
    // everything EXCEPT the link they just asked for. Same bug R-020's
    // emergency page had; see dispatchPendingNotifications' `only` parameter.
    await dispatchPendingNotifications(new Date(), 100, {
      deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
    })
  } catch (error) {
    console.error(`[dispatch] failed to send vendor link for ${workOrder.id}`, error)
    return {
      notice: 'The link was created, but sending it failed. Copy it from the work order and send it yourself.',
    }
  }

  revalidatePath(`/workorders/${workOrder.id}`)
  return { notice: `Link sent to ${workOrder.vendor.name}.` }
}

/**
 * Marks the work finished and asks the tenant (MAINT-07, R-030).
 *
 * The staff-side counterpart to R-025's vendor completion, which already
 * does the same thing through a magic link. Both end in the same place: the
 * job sits at WORK_COMPLETE while the tenant is asked whether it actually
 * is, rather than being closed on the word of whoever did the work.
 */
export async function markWorkComplete(
  workOrderId: string,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { property: true },
  })
  await requirePermission('workorder.write', propertyResource(workOrder.property))

  if (workOrder.status === 'WORK_COMPLETE') {
    return { notice: 'Already marked complete.' }
  }
  if (workOrder.status === 'CLOSED') {
    return { error: 'This job is already closed.' }
  }

  await prisma.$transaction(async (tx) => {
    await tx.workOrder.update({
      where: { id: workOrderId },
      data: { status: 'WORK_COMPLETE', completedAt: new Date() },
    })
    await audit(
      {
        action: 'workorder.work_completed',
        entityType: 'WorkOrder',
        entityId: workOrderId,
        propertyId: workOrder.propertyId,
        before: { status: workOrder.status },
        after: { status: 'WORK_COMPLETE' },
      },
      tx,
    )
  })

  // After the commit, never inside it. The work IS complete whether or not
  // the message goes out, and `requestVerification` swallows its own
  // failures for the same reason.
  await requestVerification(workOrderId)

  revalidatePath(`/workorders/${workOrderId}`)
  revalidatePath('/workorders')
  return { notice: 'Marked complete — the tenant has been asked to confirm.' }
}

/**
 * Closes the job, with what it cost (MAINT-07, R-030).
 *
 * THE LAST LINK IN THE CHAIN THE BACKLOG CALLS "the specific place owners
 * abandon software". Work order → invoice → property books, and the reason
 * it breaks in other systems is that somebody has to type the invoice total
 * a second time into the accounts, after which the two numbers drift and
 * neither can be trusted. So this action writes the money onto the work
 * order and nowhere else; every downstream reader - the property cost
 * roll-up here, R-042's QuickBooks mapping later - reads that row.
 *
 * The refusals come from `closeDecision()` in packages/core, which puts the
 * tenant's "no" ahead of every bookkeeping concern: a missing invoice is a
 * data-entry problem, and a live complaint recorded as resolved is a legal
 * one.
 */
export async function closeWorkOrder(
  workOrderId: string,
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: {
      property: true,
      ticket: { select: { id: true, status: true } },
      verifications: { orderBy: { round: 'desc' }, take: 1 },
    },
  })
  const actor = await requirePermission(
    'workorder.write',
    propertyResource(workOrder.property),
  )

  const invoiceDollars = str(formData, 'invoiceDollars')
  const invoiceCents = invoiceDollars ? Math.round(Number(invoiceDollars) * 100) : null
  if (invoiceCents != null && (!Number.isInteger(invoiceCents) || invoiceCents < 0)) {
    return {
      error: 'Check the invoice amount.',
      fieldErrors: { invoiceDollars: 'Enter a whole-dollar amount of $0 or more.' },
    }
  }

  const cause = str(formData, 'cause')
  const zeroCostAcknowledged = formData.get('zeroCost') === 'yes'

  const facts = {
    status: workOrder.status,
    tenantId: null,
    // Only the CURRENT round's answer decides. An old "no" from before the
    // job was redone is history, not a live objection - it stays on the
    // record, and blocking on it forever would make a reopened job
    // impossible to close.
    verifiedResolved:
      workOrder.verifications[0]?.round === workOrder.reopenCount + 1
        ? workOrder.verifications[0].resolved
        : null,
    actualLaborCents: workOrder.actualLaborCents,
    actualMaterialsCents: workOrder.actualMaterialsCents,
    invoiceCents: invoiceCents ?? workOrder.invoiceCents,
  }

  // MAINT-04's ceiling, on the path that money actually takes. `recordActuals`
  // has always checked this, but it is the rare path - under D-17 the normal
  // one is a vendor uploading their own invoice and a PM closing behind it,
  // and that path wrote any amount against any approval without a word.
  const policy = await policyFor(workOrder.propertyId)
  const overrun = reapprovalCheck(
    workOrder.approvedAmountCents,
    actualTotalCents(facts),
    policy,
  )

  const decision = closeDecision(
    { ...facts, overApproved: overrun.outcome === 'reapproval_required' },
    zeroCostAcknowledged,
  )
  if (!decision.allowed) {
    return {
      error:
        decision.refusal === 'over_approved' && overrun.outcome === 'reapproval_required'
          ? `This came to ${formatCents(overrun.actualCents)} against an approved ${formatCents(overrun.approvedCents)}. Send it back for approval before closing it.`
          : CLOSE_REFUSALS[decision.refusal!],
    }
  }

  const totalCents = jobCostCents(facts)

  await prisma.$transaction(async (tx) => {
    await tx.workOrder.update({
      where: { id: workOrderId },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedByStaffId: actor.id,
        ...(invoiceCents != null ? { invoiceCents } : {}),
        // MAINT-07's three-way flag. `unknown` leaves it false, which is
        // the honest default: a chargeback (R-031) must be a decision
        // somebody made, never one this action inferred from silence.
        tenantCaused: cause === 'tenant_caused',
      },
    })
    await audit(
      {
        action: 'workorder.closed',
        entityType: 'WorkOrder',
        entityId: workOrderId,
        propertyId: workOrder.propertyId,
        before: { status: workOrder.status },
        after: {
          totalCents,
          invoiceCents: facts.invoiceCents,
          actualLaborCents: facts.actualLaborCents,
          actualMaterialsCents: facts.actualMaterialsCents,
          cause: cause || 'unknown',
          // Recorded because it is the thing somebody will ask about later:
          // this job was closed without the tenant ever confirming it.
          unverified: decision.unverified === true,
        },
      },
      tx,
    )

    await closeTicketIfSettled(tx, workOrder, actor.id)
  })

  // A TENANT-CAUSED JOB GOES INTO A QUEUE, NOT INTO SOMEBODY'S MEMORY (D-43).
  //
  // Posting the charge is a separate action behind `ledger.adjust`, which
  // buys the permission boundary and the ability to bill part of a repair -
  // and costs the guarantee that a flagged job is ever billed at all. This
  // is what pays that back: one Task entity for every staff work queue (D-9),
  // so "closed as tenant-caused, never billed" is a row somebody sees rather
  // than revenue that quietly leaks.
  //
  // OUTSIDE THE TRANSACTION ABOVE, DELIBERATELY. `createTask` catches its own
  // unique violation, and a P2002 inside a transaction leaves that
  // transaction aborted at the Postgres level - the COMMIT would then act as
  // a ROLLBACK and silently undo the close. See createTask's own note. The
  // close is the fact that must survive; the task is idempotent and can be
  // retried, and `tenantCaused` on the row is a second way to find it.
  if (cause === 'tenant_caused') {
    await createTask(prisma, {
      propertyId: workOrder.propertyId,
      type: 'workorder_chargeback_decision',
      subjectType: 'WorkOrder',
      subjectId: workOrderId,
      businessDate: businessDate(new Date(), workOrder.property.timezone),
      // ROUTINE whatever the job's own priority was. A burst pipe is an
      // emergency; deciding who pays for it the next morning is not, and
      // priority inflation is how a queue stops meaning anything.
      priority: 'ROUTINE',
      title: `Decide chargeback: ${workOrder.scope.slice(0, 80)}`,
    }).catch((error) => {
      // Never fails the close. The job IS closed, and losing that to a task
      // insert would be the tail wagging the dog.
      console.error(`[close] failed to raise chargeback task for ${workOrderId}`, error)
    })
  }

  revalidatePath(`/workorders/${workOrderId}`)
  revalidatePath('/workorders')
  revalidatePath('/maintenance')
  revalidatePath('/tasks')
  if (workOrder.ticket) revalidatePath(`/maintenance/${workOrder.ticket.id}`)
  return {
    notice: decision.unverified
      ? 'Closed. Note that the tenant never confirmed this one.'
      : 'Closed.',
  }
}

/**
 * Closes the originating ticket once nothing is still being worked on it.
 *
 * WITHOUT THIS THE TENANT'S TEXT CHANNEL DIES AFTER THEIR FIRST REPAIR.
 * `createWorkOrder` moves a ticket to CONVERTED, which is correctly an OPEN
 * status - R-021's SMS intake threads an inbound text onto an open ticket
 * rather than raising a duplicate, and a tenant texting while the plumber is
 * still coming means "about that". But nothing ever moved it off CONVERTED,
 * so the ticket stayed open forever and EVERY later text from that tenant
 * threaded onto the fixed job: no new ticket, no `ticket.created`, no triage
 * Task, no SLA clock, no habitability scan. Their November "no heat" arrived
 * as a reply on August's water heater with nobody assigned to read it. It
 * also left the tenant's portal reading "Work scheduled" on a job that was
 * closed and paid.
 *
 * Conditional on the LAST one, not this one. A ticket can spawn several work
 * orders (the leak and the cabinet it ruined), and closing the ticket while
 * its sibling job is live would be the same bug pointed the other way.
 */
async function closeTicketIfSettled(
  tx: Prisma.TransactionClient,
  workOrder: { id: string; propertyId: string; ticket: { id: string; status: string } | null },
  actorStaffId: string,
) {
  const ticket = workOrder.ticket
  if (!ticket || !isOpenTicketStatus(ticket.status)) return

  const stillWorking = await tx.workOrder.count({
    where: {
      ticketId: ticket.id,
      id: { not: workOrder.id },
      status: { notIn: ['CLOSED', 'CANCELED'] },
    },
  })
  if (stillWorking > 0) return

  await tx.ticket.update({
    where: { id: ticket.id },
    data: { status: 'CLOSED', closedAt: new Date() },
  })
  await audit(
    {
      action: 'ticket.triaged',
      entityType: 'Ticket',
      entityId: ticket.id,
      propertyId: workOrder.propertyId,
      before: { status: ticket.status },
      // `reason` distinguishes this from a PM closing a ticket by hand on the
      // triage screen. Same event, because it is the same fact about the
      // ticket - but "who decided" is a question the trail should answer, and
      // here the answer is "nobody: its last job closed".
      after: { status: 'CLOSED', reason: 'work_order_closed', workOrderId: workOrder.id, actorStaffId },
    },
    tx,
  )
}

/// Written as sentences a PM can act on, not refusal codes. Each says what
/// is wrong AND what to do, because a form that only says no is a form
/// somebody works around.
const CLOSE_REFUSALS: Record<string, string> = {
  tenant_says_unresolved:
    'The tenant says this is not fixed. Sort that out first — closing it now would record a live complaint as resolved.',
  not_complete: 'Mark the work complete before closing it.',
  no_cost_recorded:
    'Record what this cost, or tick “this job cost nothing” if it genuinely did not.',
}

// Comms threading (COMM-06, R-032): staff notes, replying to the tenant or
// vendor from the work order's own page, and attaching a stray message to
// it after the fact. The vendor's own half of this - posting from the
// magic-link page - lives in lib/vendors/actions.ts, which has no session
// to check a permission against.

/**
 * The work order, plus the permission check for writing on its timeline.
 *
 * Same shape as lib/comms/actions.ts's own `threadForWrite`: loaded by id,
 * checked against ITS OWN property. `workorder.write` (not `message.send`)
 * is the gate - this is the work order's own page, and the ability to touch
 * its timeline is the same ability that already lets somebody edit the rest
 * of it.
 */
async function workOrderForCommsWrite(workOrderId: string) {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: {
      property: { select: { id: true, legalEntityId: true } },
      ticket: {
        select: {
          id: true,
          tenantId: true,
          tenant: { select: { email: true, phone: true } },
        },
      },
    },
  })
  const actor = await requirePermission('workorder.write', propertyResource(workOrder.property))
  return { workOrder, actor }
}

/**
 * A staff-only internal note (COMM-06, R-032). Never sent to anyone - see
 * `WorkOrderNote`'s own schema comment for why this is not a Message.
 */
export async function addWorkOrderNote(
  workOrderId: string,
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  const { workOrder, actor } = await workOrderForCommsWrite(workOrderId)

  const body = str(formData, 'body')
  if (!body) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { body: 'Write the note.' },
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.workOrderNote.create({
      data: { workOrderId, staffUserId: actor.id, body },
    })
    await audit(
      {
        action: 'workorder.note_added',
        entityType: 'WorkOrder',
        entityId: workOrderId,
        propertyId: workOrder.propertyId,
        after: { body },
      },
      tx,
    )
  })

  revalidatePath(`/workorders/${workOrderId}`)
  return {}
}

/**
 * A staff reply to the TENANT, sent from the work order's own page.
 *
 * Writes into the tenant's ordinary continuous thread (COMM-01 is not
 * changed by this item) but stamps `ticketId`/`workOrderId` on the Message
 * itself, which is what makes it show up on THIS job's timeline without
 * fragmenting the tenant's conversation into a separate per-ticket thread.
 */
export async function replyToTenantFromWorkOrder(
  workOrderId: string,
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  const { workOrder, actor } = await workOrderForCommsWrite(workOrderId)
  if (!workOrder.ticket?.tenantId) {
    return { error: 'There is no tenant on this job to message.' }
  }

  const channel = str(formData, 'channel')
  const body = str(formData, 'body')
  const violations = validateOutboundMessage({ threadId: 'n/a', channel, body })
    .filter((v) => v.field !== 'threadId')
  if (violations.length > 0) return violationsToState(violations)

  const tenant = workOrder.ticket.tenant
  const toAddress =
    channel === 'SMS' ? (tenant?.phone ?? null) : channel === 'EMAIL' ? (tenant?.email ?? null) : null
  if (channel !== 'PORTAL' && !toAddress) {
    return {
      error: `No ${channel === 'SMS' ? 'phone number' : 'email address'} on file for this tenant.`,
    }
  }

  const thread = await resolveThread({
    scope: 'TENANT',
    propertyId: workOrder.propertyId,
    tenantId: workOrder.ticket.tenantId,
  })
  await sendThreadMessage({
    threadId: thread.id,
    channel: channel as OutboundChannel,
    body,
    staffUserId: actor.id,
    toAddress,
    ticketId: workOrder.ticket.id,
    workOrderId,
  })

  revalidatePath(`/workorders/${workOrderId}`)
  return {}
}

/**
 * A staff reply to the VENDOR, sent from the work order's own page.
 *
 * PORTAL only - see `vendorWorkOrderThread`'s own comment for why offering
 * SMS/EMAIL here would silently fragment the conversation the vendor
 * actually reads from their magic-link page.
 */
export async function replyToVendorFromWorkOrder(
  workOrderId: string,
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  const { workOrder, actor } = await workOrderForCommsWrite(workOrderId)
  if (!workOrder.vendorId) {
    return { error: 'There is no vendor assigned to this job to message.' }
  }

  const body = str(formData, 'body')
  const violations = validateOutboundMessage({ threadId: 'n/a', channel: 'PORTAL', body })
    .filter((v) => v.field !== 'threadId')
  if (violations.length > 0) return violationsToState(violations)

  const thread = await vendorWorkOrderThread({
    id: workOrder.id,
    propertyId: workOrder.propertyId,
    vendorId: workOrder.vendorId,
  })
  await sendThreadMessage({
    threadId: thread.id,
    channel: 'PORTAL',
    body,
    staffUserId: actor.id,
    toAddress: null,
    workOrderId,
  })

  revalidatePath(`/workorders/${workOrderId}`)
  return {}
}

/**
 * Tags an existing, untagged tenant message as evidence for this job
 * (COMM-06's "reconstructing an incident from three separate histories").
 *
 * The human judgement call `unattachedTenantMessages` exists to support -
 * staff reading their recent conversation with the tenant and deciding
 * which lines were actually about this job. Refuses a message that is not
 * this tenant's, or already tagged elsewhere, the same as any other write
 * that must not let an id from somewhere else be trusted at face value.
 */
export async function attachMessageToWorkOrder(
  workOrderId: string,
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  const { workOrder, actor } = await workOrderForCommsWrite(workOrderId)
  if (!workOrder.ticket?.tenantId) {
    return { error: 'There is no tenant on this job to attach a message to.' }
  }
  const messageId = str(formData, 'messageId')

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, tenantId: true, ticketId: true, workOrderId: true, workOrderLink: true },
  })
  if (
    !message ||
    message.tenantId !== workOrder.ticket.tenantId ||
    message.ticketId != null ||
    message.workOrderId != null ||
    message.workOrderLink != null
  ) {
    return { error: 'That message could not be attached.' }
  }

  try {
    await prisma.$transaction(async (tx) => {
      // A LINK ROW, not an update to the message - Message is append-only
      // (Message_append_only rejects every UPDATE), so "attach this" cannot
      // touch the original row. See WorkOrderMessageLink's own schema
      // comment.
      await tx.workOrderMessageLink.create({
        data: { workOrderId, messageId, linkedByStaffId: actor.id },
      })
      await audit(
        {
          action: 'message.attached_to_workorder',
          entityType: 'WorkOrder',
          entityId: workOrderId,
          propertyId: workOrder.propertyId,
          after: { messageId },
        },
        tx,
      )
    })
  } catch (error) {
    // The unique index on messageId is the guard against a double-click or
    // two staff attaching the same stray text to two different jobs at
    // once.
    if (isUniqueViolation(error)) return { error: 'That message was already attached.' }
    throw error
  }

  revalidatePath(`/workorders/${workOrderId}`)
  return {}
}
