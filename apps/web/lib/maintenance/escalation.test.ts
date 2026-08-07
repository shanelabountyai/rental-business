import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emergencyPagingPlan, onCallStaffForProperty } from './emergency.ts'
import { sweepEmergencyEscalations } from './escalation.ts'

// The after-hours chain, end to end against a real database (NOTIF-05,
// R-029). The three things worth proving are all here: a rota narrows who is
// paged, NO rota still pages everybody, and an unacknowledged emergency
// reaches past whoever was paged first - until somebody says they have it.
//
// Slower than the 5s default: a sweep that escalates actually SENDS, over
// three channels per recipient, through the same dispatch path the cron
// uses. Mocking that away would leave the interesting half untested.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
let onCallId: string
let backupId: string
const ticketIds: string[] = []
const staffIds: string[] = []

const HOUR = 3_600_000

beforeAll(async () => {
  const stamp = `escalation-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '11 Escalation Row',
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
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Dana', lastName: 'Reyes', phone: '+15125550111' },
  })
  tenantId = tenant.id

  onCallId = (await makeStaff()).id
  backupId = (await makeStaff()).id
})

afterAll(async () => {
  // Notification is append-only (trigger-enforced), so deliveries go and the
  // notifications stay - same constraint R-025's cleanup ran into.
  await prisma.notificationDelivery.deleteMany({
    where: { notification: { recipientId: { in: staffIds } } },
  })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.deleteMany({ where: { id: { in: staffIds } } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  // Deactivated, NOT deleted. The escalation sweep writes `ticket.escalated`
  // audit rows carrying this property's id, and deleting the property would
  // cascade a SET NULL onto AuditLog - which the append-only trigger refuses
  // outright. The evidence trail outliving its fixtures is the product
  // working, so the fixture yields, not the trigger.
  await prisma.property.updateMany({
    where: { id: propertyId },
    data: { active: false },
  })
  await prisma.$disconnect()
})

async function makeStaff() {
  const staff = await prisma.staffUser.create({
    data: {
      email: `escalation-${randomUUID()}@example.test`,
      name: 'Escalation Test',
      phone: '+15125550100',
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, propertyId },
  })
  return staff
}

async function makeEmergency(createdAt: Date) {
  const ticket = await prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      tenantId,
      source: 'PORTAL',
      category: 'ACTIVE_FLOODING',
      description: 'Water is coming in fast.',
      priority: 'EMERGENCY',
      status: 'NEW',
      createdAt,
    },
  })
  ticketIds.push(ticket.id)
  return ticket
}

/// Clears the rota for EVERY candidate this property resolves, not just the
/// two this file seeded. A portfolio-wide grant created by another suite
/// reaches this property too, and if that person happens to be on call the
/// basis under test flips - which is the routing working correctly against a
/// precondition the test never actually established.
async function clearRota() {
  const candidates = await onCallStaffForProperty(propertyId)
  await prisma.staffUser.updateMany({
    where: { id: { in: candidates.map((c) => c.id) } },
    data: { onCallFrom: null, onCallUntil: null },
  })
}

async function setOnCall(staffId: string, window: { from: Date; until: Date } | null) {
  await prisma.staffUser.update({
    where: { id: staffId },
    data: {
      onCallFrom: window?.from ?? null,
      onCallUntil: window?.until ?? null,
    },
  })
}

async function escalationsSentFor(ticketId: string) {
  return prisma.notification.findMany({
    where: { idempotencyKey: { startsWith: `emergency-escalation:${ticketId}:` } },
    select: { recipientId: true },
  })
}

describe('the rota decides who is paged', () => {
  it('narrows to the on-call person, with everybody else behind them', async () => {
    const now = new Date()
    await clearRota()
    await setOnCall(onCallId, {
      from: new Date(now.getTime() - HOUR),
      until: new Date(now.getTime() + HOUR),
    })

    const plan = await emergencyPagingPlan(propertyId, now)
    expect(plan.basis).toBe('on_call_rota')
    expect(plan.recipients.map((r) => r.id)).toEqual([onCallId])
    expect(plan.escalationChain.map((r) => r.id)).toContain(backupId)
  })

  it('pages EVERYBODY when nobody is on call', async () => {
    // The R-026 commitment, held: narrowing is earned by somebody taking
    // responsibility. It is never assumed, because a gas leak that pages
    // nobody is not a performance win.
    const now = new Date()
    await clearRota()

    const plan = await emergencyPagingPlan(propertyId, now)
    expect(plan.basis).toBe('no_rota_paging_everyone')
    // Containment, not equality - a portfolio-wide grant elsewhere in the
    // database reaches this property too, and that is the behaviour under
    // test rather than an accident to assert away.
    expect(plan.recipients.map((r) => r.id)).toEqual(
      expect.arrayContaining([onCallId, backupId]),
    )
  })
})

describe('sweepEmergencyEscalations', { timeout: 30_000 }, () => {
  it('leaves an emergency alone before 15 minutes are up', async () => {
    const now = new Date()
    const ticket = await makeEmergency(new Date(now.getTime() - 5 * 60_000))

    await sweepEmergencyEscalations(now)
    expect(await escalationsSentFor(ticket.id)).toHaveLength(0)
  })

  it('escalates past the on-call person to the rest of the chain', async () => {
    const now = new Date()
    await clearRota()
    await setOnCall(onCallId, {
      from: new Date(now.getTime() - HOUR),
      until: new Date(now.getTime() + HOUR),
    })
    const ticket = await makeEmergency(new Date(now.getTime() - 20 * 60_000))

    const result = await sweepEmergencyEscalations(now)
    expect(result.escalated).toBeGreaterThanOrEqual(1)

    const recipients = (await escalationsSentFor(ticket.id)).map((n) => n.recipientId)
    // The backup was reached; the person who was already paged and did not
    // answer was not paged a second time.
    expect(recipients).toContain(backupId)
    expect(recipients).not.toContain(onCallId)
  })

  it('re-pages everybody when there was no rota to escalate past', async () => {
    const now = new Date()
    await clearRota()
    const ticket = await makeEmergency(new Date(now.getTime() - 20 * 60_000))

    await sweepEmergencyEscalations(now)
    const recipients = (await escalationsSentFor(ticket.id)).map((n) => n.recipientId)
    expect(recipients).toContain(onCallId)
    expect(recipients).toContain(backupId)
  })

  it('sends ONCE however many times the sweep runs', async () => {
    // The five-minute tick re-evaluates the same unacknowledged emergency
    // over and over. Notification idempotency is what makes that safe - and
    // is why there is no `lastEscalatedAt` column.
    const now = new Date()
    await clearRota()
    const ticket = await makeEmergency(new Date(now.getTime() - 20 * 60_000))

    await sweepEmergencyEscalations(now)
    const first = await escalationsSentFor(ticket.id)
    const second = await sweepEmergencyEscalations(new Date(now.getTime() + 60_000))

    expect(await escalationsSentFor(ticket.id)).toHaveLength(first.length)
    // And it does not report having escalated something it did not send.
    expect(second.escalated).toBe(0)
  })

  it('STOPS once somebody acknowledges', async () => {
    const now = new Date()
    const ticket = await makeEmergency(new Date(now.getTime() - 20 * 60_000))
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { acknowledgedAt: new Date(now.getTime() - 10 * 60_000) },
    })

    await sweepEmergencyEscalations(now)
    expect(await escalationsSentFor(ticket.id)).toHaveLength(0)
  })

  it('ignores an emergency older than a day - the chain has already run', async () => {
    const now = new Date()
    const ticket = await makeEmergency(new Date(now.getTime() - 30 * HOUR))

    await sweepEmergencyEscalations(now)
    expect(await escalationsSentFor(ticket.id)).toHaveLength(0)
  })

  it('ignores a routine ticket, however long it sits', async () => {
    const now = new Date()
    const routine = await prisma.ticket.create({
      data: {
        propertyId,
        unitId,
        tenantId,
        source: 'PORTAL',
        category: 'PLUMBING',
        description: 'Dripping tap.',
        priority: 'ROUTINE',
        status: 'NEW',
        createdAt: new Date(now.getTime() - 5 * HOUR),
      },
    })
    ticketIds.push(routine.id)

    await sweepEmergencyEscalations(now)
    expect(await escalationsSentFor(routine.id)).toHaveLength(0)
  })
})
