import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation every other job test in this codebase
// relies on.
import './alert-job.ts'

// The compliance-item alert job (PROP-05, R-077): a ROUTINE flag once an
// item enters its own lead-time window, a URGENT flag once it is overdue,
// each exactly once - and an entity-level item spanning several properties
// gets flagged exactly once too, deduped through the Task itself rather
// than any special-casing in the job.

let entityId: string
const propertyIds: string[] = []
const itemIds: string[] = []

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `Compliance LLC-${Date.now()}`, type: 'LLC' },
  })
  entityId = entity.id
})

async function seedProperty() {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `Compliance House-${unique}`,
      addressLine1: '1 Filing Ave',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return property
}

async function seedItem(overrides: {
  propertyId?: string
  legalEntityId?: string
  dueOn: string
  leadTimeDays?: number
  recurrenceMonths?: number | null
  withCompletion?: boolean
}) {
  const item = await prisma.complianceItem.create({
    data: {
      propertyId: overrides.propertyId ?? null,
      legalEntityId: overrides.legalEntityId ?? null,
      type: 'RENTAL_LICENSE',
      label: `Item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      dueOn: new Date(`${overrides.dueOn}T00:00:00Z`),
      leadTimeDays: overrides.leadTimeDays ?? 30,
      recurrenceMonths: overrides.recurrenceMonths ?? null,
    },
  })
  itemIds.push(item.id)
  if (overrides.withCompletion) {
    await prisma.complianceCompletion.create({
      data: { complianceItemId: item.id, completedOn: new Date('2026-01-01T00:00:00Z') },
    })
  }
  return item
}

async function runAt(isoInstant: string, propertyId: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

afterEach(async () => {
  await prisma.task.deleteMany({ where: { subjectId: { in: itemIds } } })
  await prisma.complianceCompletion.deleteMany({ where: { complianceItemId: { in: itemIds } } })
  await prisma.complianceItem.deleteMany({ where: { id: { in: itemIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId: { in: propertyIds } } })
  itemIds.length = 0
})

afterAll(async () => {
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

describe('the compliance alert job', () => {
  it('flags a ROUTINE task once the lead-time window opens', async () => {
    const property = await seedProperty()
    const item = await seedItem({ propertyId: property.id, dueOn: '2026-09-15', leadTimeDays: 30 })

    await runAt('2026-08-20T12:00:00Z', property.id) // 26 days out, inside the 30-day window

    const task = await prisma.task.findFirst({ where: { subjectId: item.id, type: 'compliance.item_due_soon' } })
    expect(task?.priority).toBe('ROUTINE')
    const overdue = await prisma.task.findFirst({ where: { subjectId: item.id, type: 'compliance.item_overdue' } })
    expect(overdue).toBeNull()
  })

  it('leaves an item alone well before its lead-time window', async () => {
    const property = await seedProperty()
    const item = await seedItem({ propertyId: property.id, dueOn: '2026-12-01', leadTimeDays: 30 })

    await runAt('2026-08-20T12:00:00Z', property.id)

    const task = await prisma.task.findFirst({ where: { subjectId: item.id } })
    expect(task).toBeNull()
  })

  it('flags URGENT once overdue', async () => {
    const property = await seedProperty()
    const item = await seedItem({ propertyId: property.id, dueOn: '2026-08-01', leadTimeDays: 30 })

    await runAt('2026-08-20T12:00:00Z', property.id)

    const task = await prisma.task.findFirst({ where: { subjectId: item.id, type: 'compliance.item_overdue' } })
    expect(task?.priority).toBe('URGENT')
  })

  it('never flags a one-time item that already has a completion', async () => {
    const property = await seedProperty()
    const item = await seedItem({
      propertyId: property.id,
      dueOn: '2026-08-01',
      leadTimeDays: 30,
      withCompletion: true,
    })

    await runAt('2026-08-20T12:00:00Z', property.id)

    const task = await prisma.task.findFirst({ where: { subjectId: item.id } })
    expect(task).toBeNull()
  })

  it('still flags a RECURRING item even with a past completion on file', async () => {
    const property = await seedProperty()
    const item = await seedItem({
      propertyId: property.id,
      dueOn: '2026-08-01',
      leadTimeDays: 30,
      recurrenceMonths: 12,
      withCompletion: true,
    })

    await runAt('2026-08-20T12:00:00Z', property.id)

    const task = await prisma.task.findFirst({ where: { subjectId: item.id, type: 'compliance.item_overdue' } })
    expect(task).not.toBeNull()
  })

  it('is idempotent - never flags the same threshold twice', async () => {
    const property = await seedProperty()
    const item = await seedItem({ propertyId: property.id, dueOn: '2026-08-01', leadTimeDays: 30 })

    await runAt('2026-08-20T12:00:00Z', property.id)
    await runAt('2026-08-21T12:00:00Z', property.id)

    const tasks = await prisma.task.findMany({ where: { subjectId: item.id, type: 'compliance.item_overdue' } })
    expect(tasks).toHaveLength(1)
  })

  it('flags an entity-level item exactly once, even spanning several properties', async () => {
    const propertyA = await seedProperty()
    const propertyB = await seedProperty()
    const item = await seedItem({ legalEntityId: entityId, dueOn: '2026-08-01', leadTimeDays: 30 })

    await runAt('2026-08-20T12:00:00Z', propertyA.id)
    await runAt('2026-08-20T12:00:00Z', propertyB.id)

    const tasks = await prisma.task.findMany({ where: { subjectId: item.id, type: 'compliance.item_overdue' } })
    expect(tasks).toHaveLength(1)
  })
})
