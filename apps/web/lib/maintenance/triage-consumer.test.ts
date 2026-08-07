import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// Deliberately NOT '@/lib/jobs/registrations.ts' - that file's own header
// says every consumer module is imported from exactly there so production
// never registers one twice under two module instances. This test needs
// the OPPOSITE property: registering ONLY this consumer, not every real one
// (R-016's notify-unit-make-ready included), because Vitest does not give
// each test file its own module registry the way registrations.ts's comment
// assumes - CONSUMERS is a plain array, and whatever pushes into it during
// one test file's run is still there for every other file sharing its
// worker process. Importing the whole registration chain from here once
// raced a REAL notify-unit-make-ready consumer against
// units/auto-make-ready.test.ts's own fixtures and broke its cleanup - not
// a hypothetical, an actual failure this test caused before it was scoped
// down to importing only its own consumer.
import './triage-consumer.ts'
import { dispatchOutbox, emitEvent } from '@/lib/jobs/outbox.ts'

// Every new Ticket becomes a triage Task (MAINT-02, D-9, R-023) - this is
// the consumer half; the ticket-creation half (priority, the event itself)
// is each intake path's own test.

let propertyId: string
let unitId: string
const propertyIds: string[] = []
const ticketIds: string[] = []
const taskIds: string[] = []

beforeAll(async () => {
  const stamp = `triage-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${stamp}-house`,
      addressLine1: '1 Triage Lane',
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
})

afterAll(async () => {
  // Own rows only, matched by id rather than by propertyId - this consumer
  // is scoped narrowly (see the import comment above) precisely so it does
  // NOT touch other files' fixtures, but the reverse still needs guarding:
  // this cleanup must not assume every OutboxEvent/EventConsumption row
  // against this property is one of its own if a concurrently-running file
  // ever shared it (it never does today; the same defensiveness R-020/R-021
  // already apply to their own outbox cleanup).
  await prisma.eventConsumption.deleteMany({ where: { event: { propertyId } } })
  await prisma.outboxEvent.deleteMany({ where: { propertyId } })
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.unit.deleteMany({ where: { propertyId } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedTicket(
  overrides: Partial<{
    category: string
    priority: string
    status: string
    habitabilityFlag: boolean
  }> = {},
) {
  const ticket = await prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      source: 'PORTAL',
      category: overrides.category ?? 'PLUMBING',
      description: 'A leak',
      priority: (overrides.priority ?? 'URGENT') as never,
      status: (overrides.status ?? 'NEW') as never,
      habitabilityFlag: overrides.habitabilityFlag ?? false,
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
  // Scoped to the event just emitted, never a global sweep. Four test files
  // dispatch this bus concurrently, and one worker claiming another's
  // (event, consumer) pair mid-assertion is how these went flaky.
  return dispatchOutbox(100, await onlyEventsFor(ticketId))
}

/// The ids of the events this file emitted for one aggregate.
async function onlyEventsFor(aggregateId: string) {
  const events = await prisma.outboxEvent.findMany({
    where: { aggregateId },
    select: { id: true },
  })
  return { eventIds: events.map((e) => e.id) }
}

describe('the ticket -> triage-task consumer', () => {
  it("creates a Task carrying the ticket's own priority and a readable title", async () => {
    const ticket = await seedTicket({ category: 'PLUMBING', priority: 'URGENT' })
    await fireTicketCreated(ticket.id)

    const task = await prisma.task.findFirstOrThrow({
      where: { type: 'ticket_triage', subjectId: ticket.id },
    })
    taskIds.push(task.id)
    expect(task.subjectType).toBe('Ticket')
    expect(task.propertyId).toBe(propertyId)
    expect(task.priority).toBe('URGENT')
    expect(task.title).toContain('Plumbing')
    expect(task.title).toContain('Unit A')
    expect(task.title).not.toContain('Habitability')
  })

  it("marks a habitability-flagged ticket's task title distinctly", async () => {
    const ticket = await seedTicket({
      category: 'PEST',
      priority: 'URGENT',
      habitabilityFlag: true,
    })
    await fireTicketCreated(ticket.id)

    const task = await prisma.task.findFirstOrThrow({
      where: { type: 'ticket_triage', subjectId: ticket.id },
    })
    taskIds.push(task.id)
    expect(task.title).toContain('Habitability')
  })

  it('is idempotent - a second fact about the same ticket does not create a second task', async () => {
    const ticket = await seedTicket()
    await fireTicketCreated(ticket.id)
    const first = await prisma.task.findFirstOrThrow({
      where: { type: 'ticket_triage', subjectId: ticket.id },
    })
    taskIds.push(first.id)

    // createTask's own (type, subjectId, businessDate) unique index is what
    // protects this, not EventConsumption (a genuinely new OutboxEvent row,
    // not a redelivery of the same one - jobs.test.ts already proves that
    // half).
    await fireTicketCreated(ticket.id)

    const count = await prisma.task.count({
      where: { type: 'ticket_triage', subjectId: ticket.id },
    })
    expect(count).toBe(1)
  })

  it('does nothing for a ticket that is no longer NEW by the time this runs', async () => {
    // The realistic case given the outbox's hourly-cron delivery: a PM
    // triaged it by hand well before the cron ever ran.
    const ticket = await seedTicket({ status: 'TRIAGED' })
    await fireTicketCreated(ticket.id)

    const count = await prisma.task.count({
      where: { type: 'ticket_triage', subjectId: ticket.id },
    })
    expect(count).toBe(0)
  })

  it('does nothing, and does not fail the batch, for a ticket that no longer exists', async () => {
    await emitEvent(prisma, {
      type: 'ticket.created',
      aggregateType: 'Ticket',
      aggregateId: 'not-a-real-ticket-id',
      propertyId,
      payload: {},
    })
    const result = await dispatchOutbox(100, await onlyEventsFor('not-a-real-ticket-id'))
    // A vanished ticket (a same-second merge) is not the consumer's problem
    // to raise.
    expect(result.failed).toBe(0)
  })
})
