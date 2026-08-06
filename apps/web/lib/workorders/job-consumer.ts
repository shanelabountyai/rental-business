import 'server-only'

import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { CONSUMERS } from '@/lib/jobs/outbox.ts'
import { createTask } from '@/lib/tasks/create.ts'

// A staff-assigned work order becomes a Task in the ONE staff queue (D-9,
// MAINT-03, R-024) - the "mobile job list with full context" MAINT-03 asks
// for IS the Task queue, the same call R-023 already made for triage.
//
// Vendor assignments do not reach this at all: assignWorkOrder() only emits
// workorder.assigned when assignedStaffId is set. A vendor has no login
// (D-6) and nothing to claim from a queue built for staff - R-025's own
// magic link is what reaches them.
//
// Unlike R-023's triage task, this one is pre-assigned rather than left for
// anyone to claim - a PM chose this specific tech, and leaving the Task
// unassigned would silently un-choose them.

CONSUMERS.push({
  name: 'create-workorder-job-task',
  event: 'workorder.assigned',
  handle: async (tx, event) => {
    const workOrder = await tx.workOrder.findUnique({
      where: { id: event.aggregateId },
      select: {
        id: true,
        propertyId: true,
        assignedStaffId: true,
        priority: true,
        scope: true,
        status: true,
        property: { select: { timezone: true } },
        unit: { select: { name: true } },
      },
    })
    // Gone, or reassigned to someone else (or a vendor) since this event was
    // recorded - the current assignment is what a job Task should reflect,
    // not a stale one.
    if (!workOrder || !workOrder.assignedStaffId) return
    if (workOrder.status !== 'ASSIGNED') return

    const { task, created } = await createTask(tx, {
      propertyId: workOrder.propertyId,
      type: 'workorder_job',
      subjectType: 'WorkOrder',
      subjectId: workOrder.id,
      businessDate: businessDate(event.occurredAt, workOrder.property.timezone),
      priority: workOrder.priority,
      assigneeStaffId: workOrder.assignedStaffId,
      title: `Job: ${workOrder.scope.slice(0, 60)} — ${workOrder.unit.name}`,
    })

    // Reassigned to someone else the same day: createTask()'s own idempotency
    // key is (type, subjectId, businessDate), so the second workorder.assigned
    // event returns the FIRST tech's task rather than creating a fresh one -
    // correct for "don't duplicate," wrong for "reflect who is actually
    // going." Fixed up here rather than never happening, since createTask()
    // itself has no update path and none of its other callers need one.
    //
    // The plain top-level client, deliberately NOT `tx`: `!created` means
    // createTask() just caught a P2002 on this same `tx`, which leaves it
    // aborted at the Postgres level for the rest of its lifetime (see
    // createTask()'s own comment) - any further command on `tx` here would
    // fail with 25P02, the exact bug that fix was written to stop.
    if (!created && task.assigneeStaffId !== workOrder.assignedStaffId && task.status === 'OPEN') {
      await prisma.task.update({
        where: { id: task.id },
        data: { assigneeStaffId: workOrder.assignedStaffId },
      })
    }
  },
})
