import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// Only this consumer, never '@/lib/jobs/registrations.ts' - see this
// module's own header, and triage-consumer.test.ts's, for the failure that
// rule was written from.
import './ticket-ack-consumer.ts'
import { dispatchOutbox, emitEvent } from '@/lib/jobs/outbox.ts'

// One acknowledgement per reported problem, from every intake path
// (MAINT-01, COMM-03, R-181). The intake paths themselves already emit
// `ticket.created` and each has its own test; this is the reaction.

let propertyId: string
let unitId: string
let tenantId: string
const ticketIds: string[] = []

beforeAll(async () => {
  const stamp = `ack-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${stamp}-house`,
      addressLine1: '9 Acknowledge Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: 'Unit A', status: 'OCCUPIED' },
  })
  unitId = unit.id
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Ada',
      lastName: 'Reporter',
      email: `${stamp}@example.test`,
    },
  })
  tenantId = tenant.id
})

afterAll(async () => {
  // NEITHER the OutboxEvent rows NOR their EventConsumption rows are
  // deleted, and that is not laziness. `Notification.eventId` is
  // `ON DELETE SET NULL`, so deleting an event this consumer reacted to
  // fires an UPDATE on an append-only table and Postgres refuses the whole
  // delete - CLAUDE.md's own "cleanup cannot delete a row an append-only
  // table references", met head-on. The consumption rows have to stay with
  // them: dropping those alone would leave the events looking undelivered
  // to any global sweep. Deactivating the property is the retire-don't-
  // delete answer, and it is also the marker notifications.test.ts reads as
  // "this spec has finished" (R-109).
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.unit.deleteMany({ where: { propertyId } })
  await prisma.property.update({ where: { id: propertyId }, data: { active: false } })
  await prisma.tenant.delete({ where: { id: tenantId } })
  await prisma.$disconnect()
})

async function seedTicket(
  overrides: Partial<{ source: string; priority: string; tenant: boolean }> = {},
) {
  const ticket = await prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      tenantId: overrides.tenant === false ? null : tenantId,
      source: (overrides.source ?? 'PHONE_LOGGED') as never,
      category: 'PLUMBING',
      description: 'Reported: the kitchen tap will not stop running.',
      priority: (overrides.priority ?? 'ROUTINE') as never,
      status: 'NEW',
    },
  })
  ticketIds.push(ticket.id)
  return ticket
}

async function fireTicketCreated(ticketId: string) {
  await emitEvent(prisma, {
    type: 'ticket.created',
    aggregateType: 'Ticket',
    aggregateId: ticketId,
    propertyId,
    payload: {},
  })
  // Scoped to this file's own events, never a global sweep.
  const events = await prisma.outboxEvent.findMany({
    where: { aggregateId: ticketId },
    select: { id: true },
  })
  return dispatchOutbox(100, { eventIds: events.map((e) => e.id) })
}

/// Only rows this file caused - `notification.findMany` with no scope is the
/// shared-database read CLAUDE.md names outright.
function acknowledgements(ticketId: string) {
  return prisma.notification.findMany({
    where: { templateKey: 'ticket.acknowledged', idempotencyKey: { startsWith: `ticket-ack:${ticketId}:` } },
  })
}

describe('the ticket -> acknowledgement consumer', () => {
  it('tells a phone-logged reporter we have it, with a reference they can quote', async () => {
    const ticket = await seedTicket({ source: 'PHONE_LOGGED' })
    await fireTicketCreated(ticket.id)

    const rows = await acknowledgements(ticket.id)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.category === 'maintenance_ack')).toBe(true)

    const reference = ticket.id.slice(-6).toUpperCase()
    for (const row of rows) {
      expect(row.body).toContain(reference)
      // The routine sentence, not the emergency one.
      expect(row.body).toContain('before anyone visits')
      expect(row.body).not.toContain('paged')
    }
  })

  it('says the on-call team was paged when the request was an emergency', async () => {
    const ticket = await seedTicket({ priority: 'EMERGENCY' })
    await fireTicketCreated(ticket.id)

    const rows = await acknowledgements(ticket.id)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.body).toContain('paged')
      expect(row.body).not.toContain('before anyone visits')
    }
  })

  it('leaves a texted-in request to R-177, which already answered it in seconds', async () => {
    const ticket = await seedTicket({ source: 'SMS' })
    await fireTicketCreated(ticket.id)

    expect(await acknowledgements(ticket.id)).toHaveLength(0)
  })

  it('says nothing when staff opened the ticket against a unit with no tenant', async () => {
    const ticket = await seedTicket({ tenant: false })
    await fireTicketCreated(ticket.id)

    expect(await acknowledgements(ticket.id)).toHaveLength(0)
  })

  it('acknowledges once, however many times the event is redelivered', async () => {
    const ticket = await seedTicket()
    await fireTicketCreated(ticket.id)
    const first = await acknowledgements(ticket.id)
    expect(first.length).toBeGreaterThan(0)

    await fireTicketCreated(ticket.id)
    expect(await acknowledgements(ticket.id)).toHaveLength(first.length)
  })
})
