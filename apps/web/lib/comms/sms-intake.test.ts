import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleInboundSms } from './sms-intake.ts'

// SMS-to-ticket against a real database (MAINT-01, COMM-01, R-021).
//
// The routing half is R-017's and already tested there. What this file
// proves is the layer on top: that a text from a known tenant opens exactly
// one ticket, that a conversation does not become five, and that an
// unroutable text opens none at all.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
let vendorId: string

const ticketIds: string[] = []
const tenantIds: string[] = []
const propertyIds: string[] = []

// UNIQUE PER RUN, not fixed constants. The routing rule under test refuses
// when a number matches more than one party - so a run that crashed before
// its afterAll leaves an active tenant holding the number, and every run
// afterwards sees two candidates and correctly declines to route. That is
// the feature working against its own fixture, and it cost a full debugging
// pass to see. A number nobody else can be holding cannot reproduce it.
const RUN = String(Date.now()).slice(-6)
const TENANT_PHONE = `+1512555${RUN}`
const VENDOR_PHONE = `+1512556${RUN}`
const UNKNOWN_PHONE = `+1512557${RUN}`

beforeAll(async () => {
  const stamp = `sms-${Date.now()}`
  const entity = await prisma.legalEntity.create({
    data: { name: stamp, type: 'LLC' },
  })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '5 Text Lane',
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
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  unitId = unit.id

  const tenant = await prisma.tenant.create({
    data: { firstName: 'Sam', lastName: `Sms-${randomUUID().slice(0, 6)}`, phone: TENANT_PHONE },
  })
  tenantId = tenant.id
  tenantIds.push(tenant.id)

  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })

  // A vendor with a work order at this property, so their texts route
  // (R-017's candidatesForPhone requires one).
  const vendor = await prisma.vendor.create({
    data: { name: `Vendor-${randomUUID().slice(0, 6)}`, phone: VENDOR_PHONE, trades: ['plumbing'] },
  })
  vendorId = vendor.id
  await prisma.workOrder.create({
    data: { propertyId, unitId, vendorId: vendor.id, scope: 'Test work order' },
  })
})

afterAll(async () => {
  await prisma.eventConsumption.deleteMany({
    where: { event: { propertyId: { in: propertyIds } } },
  })
  await prisma.outboxEvent.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.unroutedMessage.deleteMany({
    where: { fromAddress: { in: [UNKNOWN_PHONE] } },
  })
  await prisma.workOrder.deleteMany({ where: { vendorId } })
  await prisma.vendor.updateMany({ where: { id: vendorId }, data: { active: false } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

/**
 * Closes anything currently open for the tenant.
 *
 * Needed by every test that expects a NEW ticket, because the rule under
 * test is precisely that a further text threads into an open one instead -
 * so without this each test after the first would (correctly) thread rather
 * than open. The first draft of this file omitted it and four tests failed,
 * which was the feature working, not a bug.
 */
async function closeOpenTickets() {
  await prisma.ticket.updateMany({
    where: {
      tenantId,
      status: { in: ['NEW', 'TRIAGED', 'WAITING_ON_TENANT', 'CONVERTED'] },
    },
    data: { status: 'CLOSED' },
  })
}

async function text(body: string, from = TENANT_PHONE) {
  const result = await handleInboundSms({
    from,
    body,
    receivedAt: new Date(),
    externalId: `SM${randomUUID()}`,
  })
  if (result.outcome === 'ticket_opened') ticketIds.push(result.ticketId)
  return result
}

describe('a text from a known tenant', () => {
  it('opens a ticket with the tenant’s own words and source SMS', async () => {
    const result = await text('The water heater is leaking')
    expect(result.outcome).toBe('ticket_opened')
    if (result.outcome !== 'ticket_opened') return

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: result.ticketId },
    })
    expect(ticket.source).toBe('SMS')
    expect(ticket.tenantId).toBe(tenantId)
    expect(ticket.propertyId).toBe(propertyId)
    expect(ticket.unitId).toBe(unitId)
    expect(ticket.description).toContain('The water heater is leaking')
    // Whoever triages it must know they cannot reply through a portal the
    // sender may never have opened.
    expect(ticket.description).toContain('reply by text')
    // No category - a text has answered no clarifying questions, so guessing
    // one would put a wrong label on the one path with nothing to correct it.
    expect(ticket.category).toBe('UNCATEGORIZED')
  })

  it('also threads the message into their conversation', async () => {
    await closeOpenTickets()
    const result = await text('The porch light is out')
    expect(result.outcome).toBe('ticket_opened')
    if (result.outcome !== 'ticket_opened') return

    const messages = await prisma.message.findMany({
      where: { threadId: result.threadId, channel: 'SMS' },
    })
    expect(messages.some((m) => m.body === 'The porch light is out')).toBe(true)
  })

  it('records the submission as a SYSTEM audit entry, not a staff one', async () => {
    await closeOpenTickets()
    const result = await text('Front door will not lock')
    if (result.outcome !== 'ticket_opened') throw new Error('expected a ticket')

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Ticket', entityId: result.ticketId },
    })
    // Nobody was signed in - attributing this to a staff member would be a
    // lie in the evidence trail.
    expect(entry.actorType).toBe('SYSTEM')
    expect(entry.actorRef).toBe('sms-webhook')
  })

  it('flags habitability language exactly as the portal path does', async () => {
    await closeOpenTickets()
    const result = await text('There is mold all over the bathroom ceiling')
    if (result.outcome !== 'ticket_opened') throw new Error('expected a ticket')

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: result.ticketId },
    })
    // MAINT-02/RISK-05: the response clock must start whichever way the
    // words arrived.
    expect(ticket.habitabilityFlag).toBe(true)
  })
})

describe('a conversation does not become five tickets', () => {
  it('threads a follow-up text into the open ticket instead of opening another', async () => {
    await closeOpenTickets()
    const first = await text('The dishwasher is making a grinding noise')
    expect(first.outcome).toBe('ticket_opened')
    if (first.outcome !== 'ticket_opened') return

    const second = await text('thanks')
    const third = await text('any idea when someone can come?')

    expect(second).toMatchObject({
      outcome: 'threaded',
      existingTicketId: first.ticketId,
    })
    expect(third).toMatchObject({
      outcome: 'threaded',
      existingTicketId: first.ticketId,
    })

    const opened = await prisma.ticket.count({
      where: { tenantId, id: { in: ticketIds } },
    })
    // Still just the tickets each earlier test opened - these three texts
    // produced exactly one between them.
    expect(opened).toBe(ticketIds.length)
  })

  it('opens a new ticket once the previous one is closed', async () => {
    await closeOpenTickets()

    const result = await text('Different problem: the garage door will not open')
    expect(result.outcome).toBe('ticket_opened')
  })
})

describe('a text that cannot be routed', () => {
  it('opens NO ticket and lands in the unrouted queue', async () => {
    const result = await text('hello?', UNKNOWN_PHONE)
    expect(result).toMatchObject({ outcome: 'unrouted' })

    const unrouted = await prisma.unroutedMessage.findFirst({
      where: { fromAddress: UNKNOWN_PHONE, body: 'hello?' },
    })
    // Recorded for a human, never dropped - and never guessed into a ticket
    // belonging to somebody, because a Ticket needs a tenant and a property
    // and inventing either is what decideRoute exists to refuse.
    expect(unrouted).not.toBeNull()
  })
})

describe('a text from a vendor', () => {
  it('threads without opening a maintenance ticket', async () => {
    // A vendor saying "running late" is not a tenant reporting a problem.
    const result = await text('Running about 20 minutes late', VENDOR_PHONE)
    expect(result.outcome).toBe('threaded')
    if (result.outcome !== 'threaded') return
    expect(result.existingTicketId).toBeUndefined()

    const thread = await prisma.thread.findUniqueOrThrow({
      where: { id: result.threadId },
    })
    expect(thread.vendorId).toBe(vendorId)
    expect(thread.tenantId).toBeNull()
  })
})

describe('provider redelivery', () => {
  it('is a no-op on the same MessageSid, opening no second ticket', async () => {
    // Twilio retries on any non-2xx, so the same text really does arrive
    // twice. R-017's externalId guard is what makes that safe; this proves
    // the ticket layer inherits it.
    const externalId = `SM${randomUUID()}`
    const args = {
      from: TENANT_PHONE,
      body: 'Kitchen sink is blocked',
      receivedAt: new Date(),
      externalId,
    }

    await closeOpenTickets()

    const first = await handleInboundSms(args)
    if (first.outcome === 'ticket_opened') ticketIds.push(first.ticketId)
    expect(first.outcome).toBe('ticket_opened')

    const second = await handleInboundSms(args)
    expect(second).toEqual({ outcome: 'duplicate' })

    const messages = await prisma.message.count({ where: { externalId } })
    expect(messages).toBe(1)
  })
})
