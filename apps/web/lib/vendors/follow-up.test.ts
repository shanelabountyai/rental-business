import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { vendorFollowUp } from './follow-up.ts'

// Somebody is subscribed to the vendor (MAINT-03, COMM-06, R-032a; D-9).
//
// The assertion that matters most is the DECLINE. A vendor who never answers
// is caught by `sweepUnansweredDispatches`; a vendor who declines has
// responded, so that sweep's `vendorRespondedAt: null` filter steps over them
// and — before this — nothing else raised anything at all. There is a test
// below that pins exactly that asymmetry, because it is invisible from inside
// either function.

let entityId: string
let propertyId: string
let unitId: string
let vendorId: string
let staffId: string

beforeAll(async () => {
  const stamp = `followup-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '2 Decline Drive',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  unitId = unit.id
  const vendor = await prisma.vendor.create({
    data: { name: `Pipes-${randomUUID().slice(0, 6)}`, trades: ['PLUMBING'] },
  })
  vendorId = vendor.id

  // A staff member who can DISPATCH, which is who a decline is for. The
  // helper asks for `workorder.write` rather than `unit.write` precisely so
  // the people told are the people who can act.
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  const staff = await prisma.staffUser.create({
    data: {
      email: `followup-${randomUUID()}@example.test`,
      name: 'Dispatch Manager',
    },
  })
  staffId = staff.id
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, propertyId },
  })
})

afterAll(async () => {
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.vendor.updateMany({ where: { id: vendorId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedWorkOrder(priority: 'EMERGENCY' | 'URGENT' | 'ROUTINE' = 'URGENT') {
  const ticket = await prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      description: 'Water pooling in the cabinet under the kitchen sink.',
      category: 'PLUMBING',
      priority,
      status: 'TRIAGED',
      source: 'PORTAL',
    },
  })
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      ticketId: ticket.id,
      vendorId,
      scope: 'Replace the trap and check the shutoff',
      priority,
      status: 'ASSIGNED',
      dispatchedAt: new Date(),
    },
  })
  return prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrder.id },
    select: {
      id: true,
      propertyId: true,
      scope: true,
      priority: true,
      unit: { select: { name: true } },
      property: { select: { name: true, timezone: true } },
      vendor: { select: { name: true } },
    },
  })
}

const tasksFor = (workOrderId: string) =>
  prisma.task.findMany({ where: { subjectId: workOrderId }, orderBy: { createdAt: 'asc' } })

/// The Notification rows, not the Delivery rows: `idempotencyKey` and
/// `channel` both live on Notification, and one logical send fans out to a
/// row per channel — which is exactly what these tests assert about.
const notificationsFor = (workOrderId: string) =>
  prisma.notification.findMany({ where: { idempotencyKey: { contains: workOrderId } } })

describe('vendorFollowUp', () => {
  it('RAISES WORK WHEN A VENDOR DECLINES — the hole this item exists to close', async () => {
    const workOrder = await seedWorkOrder('URGENT')
    await vendorFollowUp(workOrder, { kind: 'declined', declineReason: 'No van until Tuesday' })

    const tasks = await tasksFor(workOrder.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.type).toBe('workorder_redispatch')
    expect(tasks[0]!.title).toContain('declined')
    // The JOB's priority, not a downgrade. A declined urgent job is still
    // urgent — nothing has been fixed.
    expect(tasks[0]!.priority).toBe('URGENT')
  }, 20_000)

  it('tells somebody, because a decline will not keep until morning', async () => {
    const workOrder = await seedWorkOrder('EMERGENCY')
    await vendorFollowUp(workOrder, { kind: 'declined', declineReason: null })

    const deliveries = await notificationsFor(workOrder.id)
    expect(deliveries.length).toBeGreaterThan(0)
    // SMS is on this template deliberately — an email at 6pm about a burst
    // pipe arrives too late to be a notification.
    expect(deliveries.map((d) => d.channel)).toContain('SMS')
  }, 20_000)

  it('carries the reason through, because it changes who you call next', async () => {
    const workOrder = await seedWorkOrder()
    await vendorFollowUp(workOrder, { kind: 'declined', declineReason: 'Not my trade' })

    const deliveries = await notificationsFor(workOrder.id)
    const bodies = deliveries.map((d) => `${d.subject ?? ''} ${d.body ?? ''}`).join(' ')
    expect(bodies).toContain('Not my trade')
  }, 20_000)

  it('raises a SCHEDULE task on accept — accepting is not scheduling', async () => {
    // R-027 owns confirming a window, and `respondToWorkOrder` leaves an
    // accepted job ASSIGNED on purpose. Until this, that gap was represented
    // by nothing: an accepted job looked exactly like an untouched one.
    const workOrder = await seedWorkOrder()
    await vendorFollowUp(workOrder, { kind: 'accepted' })

    const tasks = await tasksFor(workOrder.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.type).toBe('workorder_schedule')
    expect(tasks[0]!.title).toContain('confirm a window')
  }, 20_000)

  it('raises one on a proposed time too — they have responded, so the sweep skips them', async () => {
    const workOrder = await seedWorkOrder()
    await vendorFollowUp(workOrder, { kind: 'proposed_time' })

    const tasks = await tasksFor(workOrder.id)
    expect(tasks[0]!.type).toBe('workorder_schedule')
    expect(tasks[0]!.title).toContain('proposed a time')
  }, 20_000)

  it('surfaces an inbound message, which R-032 left unread', async () => {
    const workOrder = await seedWorkOrder('EMERGENCY')
    await vendorFollowUp(workOrder, {
      kind: 'message',
      body: '  Is the water   shut off at the main?  ',
    })

    const tasks = await tasksFor(workOrder.id)
    expect(tasks[0]!.type).toBe('workorder_vendor_message')
    // ROUTINE even on an emergency job. A question about an emergency is not
    // itself an emergency, and paging on every message empties the urgent
    // queue of meaning.
    expect(tasks[0]!.priority).toBe('ROUTINE')
    // Whitespace collapsed, so a vendor's stray newlines do not reach an SMS.
    expect(tasks[0]!.title).toContain('Is the water shut off')

    const deliveries = await notificationsFor(workOrder.id)
    expect(deliveries.length).toBeGreaterThan(0)
    // NO SMS here, unlike a decline. This one can wait until somebody sits
    // down, and the split is the whole reason the category is separate.
    expect(deliveries.map((d) => d.channel)).not.toContain('SMS')
  }, 20_000)

  it('raises an invoice task, but NOT when the ceiling already did', async () => {
    const within = await seedWorkOrder()
    await vendorFollowUp(within, { kind: 'invoice', overCeiling: false })
    expect((await tasksFor(within.id))[0]!.type).toBe('workorder_invoice_review')

    // An over-ceiling invoice already moves the job to PENDING_APPROVAL and
    // raises its own approval task. A second row would be two queue entries
    // for one decision.
    const over = await seedWorkOrder()
    await vendorFollowUp(over, { kind: 'invoice', overCeiling: true })
    expect(await tasksFor(over.id)).toHaveLength(0)
  }, 20_000)

  it('is idempotent within a day, so a retried action bills no second task', async () => {
    const workOrder = await seedWorkOrder()
    await vendorFollowUp(workOrder, { kind: 'declined', declineReason: null })
    await vendorFollowUp(workOrder, { kind: 'declined', declineReason: null })

    expect(await tasksFor(workOrder.id)).toHaveLength(1)
  }, 20_000)

  it('NEVER throws into the caller, whatever goes wrong downstream', async () => {
    // Every call site is a vendor on a magic link who has just done what was
    // asked. Their acceptance happened; an outage on our side must not show
    // them an error.
    const broken = {
      id: 'wo_does_not_exist',
      propertyId: 'prop_does_not_exist',
      scope: 'x',
      priority: 'ROUTINE' as const,
      unit: { name: 'U' },
      property: { name: 'P', timezone: 'America/Chicago' },
      vendor: { name: 'V' },
    }
    await expect(vendorFollowUp(broken, { kind: 'accepted' })).resolves.toBeUndefined()
  }, 20_000)
})
