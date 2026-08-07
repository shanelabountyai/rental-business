import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// Deliberately NOT '@/lib/jobs/registrations.ts' - see
// maintenance/triage-consumer.test.ts's own header for why a Vitest test
// registers only the ONE consumer it means to exercise, not the whole real
// registration chain.
import './job-consumer.ts'
import { dispatchOutbox, emitEvent } from '@/lib/jobs/outbox.ts'

// A staff-assigned work order becomes a Task in the ONE staff queue (D-9,
// MAINT-03, R-024) - this is the consumer half; assignWorkOrder() emitting
// the event is its own action's concern, exercised at the e2e layer.

let propertyId: string
let unitId: string
let staffAId: string
let staffBId: string
const propertyIds: string[] = []
const workOrderIds: string[] = []
const taskIds: string[] = []
const staffIds: string[] = []

beforeAll(async () => {
  const stamp = `wojob-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${stamp}-house`,
      addressLine1: '1 Job Lane',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId, name: 'Unit A', status: 'OCCUPIED' },
  })
  unitId = unit.id

  const staffA = await prisma.staffUser.create({ data: { email: `${stamp}-a@example.test`, name: 'Tech A' } })
  const staffB = await prisma.staffUser.create({ data: { email: `${stamp}-b@example.test`, name: 'Tech B' } })
  staffAId = staffA.id
  staffBId = staffB.id
  staffIds.push(staffA.id, staffB.id)
})

afterAll(async () => {
  await prisma.eventConsumption.deleteMany({ where: { event: { propertyId } } })
  await prisma.outboxEvent.deleteMany({ where: { propertyId } })
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.unit.deleteMany({ where: { propertyId } })
  await prisma.staffUser.deleteMany({ where: { id: { in: staffIds } } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedAssignedWorkOrder(assignedStaffId: string) {
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      scope: 'Replace the garbage disposal',
      priority: 'URGENT',
      status: 'ASSIGNED',
      assignedStaffId,
    },
  })
  workOrderIds.push(workOrder.id)
  return workOrder
}

async function fireAssigned(workOrderId: string) {
  await emitEvent(prisma, {
    type: 'workorder.assigned',
    aggregateType: 'WorkOrder',
    aggregateId: workOrderId,
    propertyId,
    payload: {},
  })
  // Scoped to the event just emitted, never a global sweep. Four test files
  // dispatch this bus concurrently, and one worker claiming another's
  // (event, consumer) pair mid-assertion is how these went flaky.
  return dispatchOutbox(100, await onlyEventsFor(workOrderId))
}

/// The ids of the events this file emitted for one aggregate.
async function onlyEventsFor(aggregateId: string) {
  const events = await prisma.outboxEvent.findMany({
    where: { aggregateId },
    select: { id: true },
  })
  return { eventIds: events.map((e) => e.id) }
}

describe('the workorder.assigned -> job-task consumer', () => {
  it('creates a Task pre-assigned to the tech, not left for anyone to claim', async () => {
    const workOrder = await seedAssignedWorkOrder(staffAId)
    await fireAssigned(workOrder.id)

    const task = await prisma.task.findFirstOrThrow({
      where: { type: 'workorder_job', subjectId: workOrder.id },
    })
    taskIds.push(task.id)
    expect(task.subjectType).toBe('WorkOrder')
    expect(task.assigneeStaffId).toBe(staffAId)
    expect(task.priority).toBe('URGENT')
    expect(task.title).toContain('garbage disposal')
    expect(task.title).toContain('Unit A')
  })

  it('does nothing for a work order assigned to a vendor, not staff', async () => {
    const workOrder = await prisma.workOrder.create({
      data: {
        propertyId,
        unitId,
        scope: 'Vendor job',
        priority: 'ROUTINE',
        status: 'ASSIGNED',
        // No vendor row seeded here - assignedStaffId simply absent is
        // enough to prove the consumer's own guard, matching how
        // assignWorkOrder() never emits this event for a vendor assignment
        // in the first place (belt and suspenders).
      },
    })
    workOrderIds.push(workOrder.id)
    await fireAssigned(workOrder.id)

    const count = await prisma.task.count({
      where: { type: 'workorder_job', subjectId: workOrder.id },
    })
    expect(count).toBe(0)
  })

  it('reassignment on the same day updates the existing open task rather than orphaning it', async () => {
    const workOrder = await seedAssignedWorkOrder(staffAId)
    await fireAssigned(workOrder.id)
    const first = await prisma.task.findFirstOrThrow({
      where: { type: 'workorder_job', subjectId: workOrder.id },
    })
    taskIds.push(first.id)
    expect(first.assigneeStaffId).toBe(staffAId)

    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { assignedStaffId: staffBId },
    })
    await fireAssigned(workOrder.id)

    const stillOneTask = await prisma.task.count({
      where: { type: 'workorder_job', subjectId: workOrder.id },
    })
    expect(stillOneTask).toBe(1)
    const updated = await prisma.task.findUniqueOrThrow({ where: { id: first.id } })
    expect(updated.assigneeStaffId).toBe(staffBId)
  })

  it('does not reopen or reassign an already-completed job task', async () => {
    const workOrder = await seedAssignedWorkOrder(staffAId)
    await fireAssigned(workOrder.id)
    const task = await prisma.task.findFirstOrThrow({
      where: { type: 'workorder_job', subjectId: workOrder.id },
    })
    taskIds.push(task.id)
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'DONE', completedAt: new Date() },
    })

    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { assignedStaffId: staffBId },
    })
    await fireAssigned(workOrder.id)

    const unchanged = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(unchanged.status).toBe('DONE')
    expect(unchanged.assigneeStaffId).toBe(staffAId)
  })
})
