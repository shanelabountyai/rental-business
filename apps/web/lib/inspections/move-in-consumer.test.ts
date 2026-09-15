import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { dispatchOutbox, emitEvent } from '../jobs/outbox.ts'
// Side-effect import: registers the real consumer into this file's own
// CONSUMERS - the same isolation delist.test.ts relies on for the other
// `lease.activated` consumer. It is also what makes the globally-UNIQUE
// `defaultForType: 'MOVE_IN'` template this file writes safe in the shared
// database: no other vitest file has this consumer registered, so nobody
// else's lease activation reacts to it.
import './move-in-consumer.ts'

// R-208. A tenancy going live opens its own move-in condition report, so the
// deposit case has a left-hand side without anybody pressing a button.
//
// Driven through a real `lease.activated` event rather than through
// `changeLeaseStatus`, which is session-dependent (`requirePermission`) - the
// same split delist.test.ts documents for the consumer sitting next to this
// one. All three paths that actually reach ACTIVE emit this one event through
// `activateLeaseSideEffects`, so the event IS the activation.

let entityId: string
let propertyId: string
let staffId: string
const unitIds: string[] = []
const leaseIds: string[] = []
const tenantIds: string[] = []
const templateIds: string[] = []
const inspectionIds: string[] = []

beforeAll(async () => {
  const stamp = `movein-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '4 Baseline Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const staff = await prisma.staffUser.create({
    data: { email: `${stamp}@example.test`, name: 'Checklist Author' },
  })
  staffId = staff.id
})

afterEach(async () => {
  // THE OUTBOX ROWS STAY. delist.test.ts deletes its own OutboxEvent rows and
  // this file cannot: `Notification.eventId` points at them with a SetNull
  // cascade, and SetNull is an UPDATE, which the append-only trigger refuses
  // outright - `Notification is append-only; UPDATE is not permitted`. The
  // delete fails on the OutboxEvent, not on the Notification, which is what
  // makes it read as an unrelated cleanup bug (CLAUDE.md's first append-only
  // consequence, third instance). They accumulate under this file's own
  // property, deactivated whole in afterAll, which is the ownership marker
  // notifications.test.ts reads as "this spec has finished".
  //
  // The template is deleted LAST of the three it is entangled with: an
  // Inspection carries `templateId`, and it must not outlive the test that
  // wrote it - `defaultForType` is globally UNIQUE, so a leaked row is one
  // every later test in this file collides with.
  await prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: inspectionIds } } })
  await prisma.inspection.deleteMany({ where: { id: { in: inspectionIds } } })
  await prisma.inspectionTemplate.deleteMany({ where: { id: { in: templateIds } } })
  inspectionIds.length = 0
  templateIds.length = 0
})

afterAll(async () => {
  // Retire rather than delete: `auditAsSystem` writes an append-only
  // AuditLog row against this property every time the consumer opens a
  // report, and `Notification` is append-only too.
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedMoveInTemplate() {
  const template = await prisma.inspectionTemplate.create({
    data: {
      name: `Move-in checklist ${randomUUID().slice(0, 6)}`,
      defaultForType: 'MOVE_IN',
      createdByStaffId: staffId,
      items: [
        { room: 'Kitchen', item: 'Countertops' },
        { room: 'Living room', item: 'Walls and paint' },
      ],
    },
  })
  templateIds.push(template.id)
  return template
}

async function seedLease(origin: 'APPLICATION' | 'INHERITED' | 'RENEWAL' = 'APPLICATION') {
  const unique = randomUUID().slice(0, 8)
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${unique}`, status: 'OCCUPIED' },
  })
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Pat', lastName: 'Renter', email: `pat-${unique}@example.test` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      origin,
      startsOn: new Date('2026-09-01T00:00:00Z'),
      rentCents: 150_000,
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  return { unit, lease, tenant }
}

/// Emits the activation event and dispatches it, exactly as
/// `activateLeaseSideEffects` + the cron route do in production.
async function activate(lease: { id: string; unitId: string }) {
  await emitEvent(prisma, {
    type: 'lease.activated',
    aggregateType: 'Lease',
    aggregateId: lease.id,
    propertyId,
    payload: { unitId: lease.unitId },
  })
  const event = await prisma.outboxEvent.findFirstOrThrow({
    where: { type: 'lease.activated', aggregateId: lease.id },
  })
  const result = await dispatchOutbox(100, { eventIds: [event.id] })
  expect(result.failed).toBe(0)
  const opened = await prisma.inspection.findMany({
    where: { leaseId: lease.id, type: 'MOVE_IN' },
    include: { items: { orderBy: { order: 'asc' } } },
  })
  for (const row of opened) if (!inspectionIds.includes(row.id)) inspectionIds.push(row.id)
  return opened
}

describe('move-in-consumer: lease.activated opens the move-in condition report', () => {
  it('opens a self-guided MOVE_IN report from the default checklist', async () => {
    const template = await seedMoveInTemplate()
    const { lease } = await seedLease()

    const [inspection] = await activate(lease)

    expect(inspection).toBeDefined()
    expect(inspection!.selfGuided).toBe(true)
    expect(inspection!.performedAt).toBeNull()
    expect(inspection!.templateId).toBe(template.id)
    expect(inspection!.items.map((i) => i.item)).toEqual(['Countertops', 'Walls and paint'])

    // `selfGuided` is not decoration: `inspection.move_in_overdue` selects on
    // it, so a report opened without it would be invisible to the very job
    // this item exists to give something to watch.
    const watched = await prisma.inspection.findFirst({
      where: { id: inspection!.id, type: 'MOVE_IN', selfGuided: true, performedAt: null },
    })
    expect(watched).not.toBeNull()
  })

  it('tells the primary tenant, and records who opened it', async () => {
    await seedMoveInTemplate()
    const { lease, tenant } = await seedLease()

    const [inspection] = await activate(lease)

    const notification = await prisma.notification.findFirst({
      where: { propertyId, recipientId: tenant.id, templateKey: 'inspection.move_in_ready' },
    })
    expect(notification).not.toBeNull()

    const audited = await prisma.auditLog.findFirst({
      where: { action: 'inspection.created', entityId: inspection!.id },
    })
    expect(audited?.actorType).toBe('SYSTEM')
  })

  it('opens one for an INHERITED tenancy - the case with the LEAST baseline', async () => {
    await seedMoveInTemplate()
    const { lease } = await seedLease('INHERITED')

    expect(await activate(lease)).toHaveLength(1)
  })

  it('opens NONE for a renewal - nobody moved in', async () => {
    await seedMoveInTemplate()
    const { lease } = await seedLease('RENEWAL')

    expect(await activate(lease)).toHaveLength(0)
  })

  it('opens none, and does not throw, when no MOVE_IN checklist is designated', async () => {
    const { lease } = await seedLease()

    // An inspection with zero items would be worse than none:
    // `canFinishInspection` refuses an empty checklist, so it could never be
    // completed and the overdue job would raise a Task about it every day
    // forever. The access-code Task carries the warning instead
    // (deposit-clearing-job.ts), so the gap is loud without being blocking.
    expect(await activate(lease)).toHaveLength(0)
  })

  it('never stacks a second report on a lease that already has one', async () => {
    await seedMoveInTemplate()
    const { lease, unit } = await seedLease()
    const existing = await prisma.inspection.create({
      data: { propertyId, unitId: unit.id, leaseId: lease.id, type: 'MOVE_IN' },
    })
    inspectionIds.push(existing.id)

    const opened = await activate(lease)
    expect(opened).toHaveLength(1)
    expect(opened[0]!.id).toBe(existing.id)
  })
})
