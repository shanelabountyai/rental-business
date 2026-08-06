'use server'

import { type WorkOrderInput, validateAssignment, validateWorkOrder } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { emitEvent } from '@/lib/jobs/outbox.ts'
import { completeTaskWork } from '@/lib/tasks/complete.ts'

// Writes for work orders (MAINT-03, PROP-06, R-024). Same shape as every
// other lib/*/actions.ts write in this repo: a resource-carrying permission
// check first, then a transaction pairing the write with its audit entry.

export interface WorkOrderFormState {
  error?: string
  fieldErrors?: Record<string, string>
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

  await prisma.$transaction(async (tx) => {
    const updated = await tx.workOrder.update({
      where: { id: workOrderId },
      data: {
        assignedStaffId,
        vendorId,
        status: 'ASSIGNED',
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
