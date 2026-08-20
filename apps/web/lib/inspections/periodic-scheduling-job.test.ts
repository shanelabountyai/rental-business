import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation pre-move-out-scheduling-job.test.ts
// already relies on.
import './periodic-scheduling-job.ts'

// The periodic scheduling job (INSP-04, R-073): a unit's next PERIODIC/
// SEASONAL/DRIVE_BY inspection appears on its own calendar, from whichever
// checklist a PM designated as that type's default.

const STATE = 'YQ' // not a real US state code, isolated from every other test's own state fixture.
const CHICAGO = 'America/Chicago'

let entityId: string
let staffId: string
const propertyIds: string[] = []
const unitIds: string[] = []
const templateIds: string[] = []
const inspectionIds: string[] = []

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `Periodic LLC-${Date.now()}`, type: 'LLC' },
  })
  entityId = entity.id
  const staff = await prisma.staffUser.create({
    data: { email: `periodic-job-${Date.now()}@example.test`, name: 'Checklist Author' },
  })
  staffId = staff.id
})

afterEach(async () => {
  // NOT the property: `auditAsSystem` writes a real AuditLog row with a FK
  // to `propertyId` every time the job schedules an inspection - same
  // "retire, don't delete" reasoning pre-move-out-scheduling-job.test.ts's
  // own afterEach documents.
  await prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: inspectionIds } } })
  await prisma.task.deleteMany({ where: { subjectId: { in: unitIds } } })
  await prisma.inspection.deleteMany({ where: { id: { in: inspectionIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.inspectionTemplate.deleteMany({ where: { id: { in: templateIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId: { in: propertyIds } } })
  inspectionIds.length = 0
  unitIds.length = 0
  templateIds.length = 0
})

afterAll(async () => {
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedProperty() {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `Periodic House-${unique}`,
      addressLine1: '1 Rotation Rd',
      city: 'Anytown',
      state: STATE,
      postalCode: '00000',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return property
}

async function seedUnit(propertyId: string) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const unit = await prisma.unit.create({ data: { propertyId, name: `U-${unique}`, status: 'OCCUPIED' } })
  unitIds.push(unit.id)
  return unit
}

async function seedDefaultTemplate(type: 'PERIODIC' | 'SEASONAL' | 'DRIVE_BY') {
  const template = await prisma.inspectionTemplate.create({
    data: {
      name: `${type} checklist`,
      items: [{ room: 'Exterior', item: 'Roof' }],
      defaultForType: type,
      createdByStaffId: staffId,
    },
  })
  templateIds.push(template.id)
  return template
}

async function runAt(isoInstant: string, propertyId: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

describe('the periodic scheduling job', () => {
  it('schedules a PERIODIC inspection for a unit never inspected before', async () => {
    const property = await seedProperty()
    const unit = await seedUnit(property.id)
    await seedDefaultTemplate('PERIODIC')

    await runAt('2026-08-15T12:00:00Z', property.id)

    const created = await prisma.inspection.findFirst({
      where: { unitId: unit.id, type: 'PERIODIC' },
      include: { items: true },
    })
    inspectionIds.push(created!.id)
    expect(created).not.toBeNull()
    // Never inspected before: due today, not a year out.
    expect(created!.scheduledFor?.toISOString().slice(0, 10)).toBe('2026-08-15')
    expect(created!.items).toHaveLength(1)
    expect(created!.items[0]!.room).toBe('Exterior')

    const task = await prisma.task.findFirst({
      where: { subjectId: unit.id, type: 'inspection.periodic_scheduled' },
    })
    expect(task).not.toBeNull()
  })

  it('schedules nothing for a type with no default checklist designated', async () => {
    const property = await seedProperty()
    await seedUnit(property.id)
    // No seedDefaultTemplate call at all.

    await runAt('2026-08-15T12:00:00Z', property.id)

    const created = await prisma.inspection.count({ where: { propertyId: property.id, type: 'SEASONAL' } })
    expect(created).toBe(0)
  })

  it('does not schedule again while a cycle is still open (unperformed)', async () => {
    const property = await seedProperty()
    const unit = await seedUnit(property.id)
    await seedDefaultTemplate('DRIVE_BY')

    await runAt('2026-08-15T12:00:00Z', property.id)
    await runAt('2026-08-16T12:00:00Z', property.id)

    const all = await prisma.inspection.findMany({ where: { unitId: unit.id, type: 'DRIVE_BY' } })
    all.forEach((i) => inspectionIds.push(i.id))
    expect(all).toHaveLength(1)
  })

  it('schedules the next cycle once the last one was performed and the interval has passed', async () => {
    const property = await seedProperty()
    const unit = await seedUnit(property.id)
    const template = await seedDefaultTemplate('SEASONAL')

    const previous = await prisma.inspection.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        type: 'SEASONAL',
        templateId: template.id,
        performedAt: new Date('2026-01-10T12:00:00Z'),
        items: { create: [{ room: 'Exterior', item: 'Gutters', order: 0 }] },
      },
    })
    inspectionIds.push(previous.id)

    // SEASONAL's interval is 6 months: due 2026-07-10, not yet on 2026-06-01.
    await runAt('2026-06-01T12:00:00Z', property.id)
    expect(
      await prisma.inspection.count({ where: { unitId: unit.id, type: 'SEASONAL', id: { not: previous.id } } }),
    ).toBe(0)

    await runAt('2026-07-15T12:00:00Z', property.id)
    const next = await prisma.inspection.findFirst({
      where: { unitId: unit.id, type: 'SEASONAL', id: { not: previous.id } },
    })
    inspectionIds.push(next!.id)
    expect(next!.scheduledFor?.toISOString().slice(0, 10)).toBe('2026-07-10')
  })
})
