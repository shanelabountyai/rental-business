import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation every other job test in this codebase
// relies on.
import './court-date-reminder-job.ts'

// Court-date reminders (RISK-09, review §9): T-7 and T-1 Tasks on a
// scheduled eviction hearing, each raised exactly once, plus a Task when a
// hearing inside that week has a DMDC search on file more than 30 days
// stale (R-085's LOOKUP_STALE_AFTER_DAYS).

const CHICAGO = 'America/Chicago'

let entityId: string
let propertyId: string
let staffId: string
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []
const caseIds: string[] = []

beforeAll(async () => {
  const stamp = `courtreminder-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '1 Docket Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const staff = await prisma.staffUser.create({
    data: { email: `courtreminder-${Date.now()}@example.test`, name: 'Case Handler' },
  })
  staffId = staff.id
})

afterEach(async () => {
  await prisma.scraLookup.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.task.deleteMany({ where: { subjectId: { in: caseIds } } })
  await prisma.evictionCase.deleteMany({ where: { id: { in: caseIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  caseIds.length = 0
  leaseIds.length = 0
  tenantIds.length = 0
  unitIds.length = 0
})

afterAll(async () => {
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedCase(unique: string, courtDate: string, stage: 'COURT' | 'CLOSED' = 'COURT') {
  const unit = await prisma.unit.create({ data: { propertyId, name: `U-${unique}`, status: 'OCCUPIED' } })
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({ data: { firstName: 'Sam', lastName: `Resident-${unique}` } })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: { propertyId, unitId: unit.id, status: 'ACTIVE', startsOn: new Date('2026-01-01'), rentCents: 150_000 },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true } })
  const evictionCase = await prisma.evictionCase.create({
    data: {
      propertyId,
      unitId: unit.id,
      leaseId: lease.id,
      openedByStaffId: staffId,
      stage,
      outcome: stage === 'CLOSED' ? 'DISMISSED' : undefined,
      courtDate: new Date(courtDate),
    },
  })
  caseIds.push(evictionCase.id)
  return { lease, tenant, evictionCase }
}

async function seedLookup(leaseId: string, tenantId: string, searchedOn: string) {
  return prisma.scraLookup.create({
    data: {
      leaseId,
      propertyId,
      tenantId,
      result: 'NOT_IN_SERVICE',
      searchedOn: new Date(searchedOn),
      recordedByStaffId: staffId,
    },
  })
}

async function runAt(isoInstant: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

describe('the court-date reminder job', () => {
  it('flags T-7 exactly seven days before the hearing', async () => {
    const { evictionCase } = await seedCase('a', '2026-09-08T18:00:00Z')
    await runAt('2026-09-01T12:00:00Z')

    const task = await prisma.task.findFirst({
      where: { subjectId: evictionCase.id, type: 'eviction.court_date_t7' },
    })
    expect(task?.priority).toBe('ROUTINE')
  })

  it('flags T-1 the day before the hearing, URGENT', async () => {
    const { evictionCase } = await seedCase('b', '2026-09-02T18:00:00Z')
    await runAt('2026-09-01T12:00:00Z')

    const task = await prisma.task.findFirst({
      where: { subjectId: evictionCase.id, type: 'eviction.court_date_t1' },
    })
    expect(task?.priority).toBe('URGENT')
  })

  it('leaves a hearing outside the T-7/T-1 window alone', async () => {
    const { evictionCase } = await seedCase('c', '2026-09-15T18:00:00Z')
    await runAt('2026-09-01T12:00:00Z')

    const tasks = await prisma.task.findMany({ where: { subjectId: evictionCase.id } })
    expect(tasks).toHaveLength(0)
  })

  it('never checks a closed case', async () => {
    const { evictionCase } = await seedCase('d', '2026-09-08T18:00:00Z', 'CLOSED')
    await runAt('2026-09-01T12:00:00Z')

    const tasks = await prisma.task.findMany({ where: { subjectId: evictionCase.id } })
    expect(tasks).toHaveLength(0)
  })

  it('flags a stale DMDC search inside the week before a hearing', async () => {
    const { evictionCase, lease, tenant } = await seedCase('e', '2026-09-05T18:00:00Z')
    await seedLookup(lease.id, tenant.id, '2026-07-01') // 62 days before the run
    await runAt('2026-09-01T12:00:00Z')

    const task = await prisma.task.findFirst({
      where: { subjectId: evictionCase.id, type: 'eviction.scra_search_stale' },
    })
    expect(task).not.toBeNull()
  })

  it('leaves a fresh DMDC search alone', async () => {
    const { evictionCase, lease, tenant } = await seedCase('f', '2026-09-05T18:00:00Z')
    await seedLookup(lease.id, tenant.id, '2026-08-20') // 12 days before the run
    await runAt('2026-09-01T12:00:00Z')

    const task = await prisma.task.findFirst({
      where: { subjectId: evictionCase.id, type: 'eviction.scra_search_stale' },
    })
    expect(task).toBeNull()
  })

  it('does not invent a staleness warning when no search is on file at all', async () => {
    const { evictionCase } = await seedCase('g', '2026-09-05T18:00:00Z')
    await runAt('2026-09-01T12:00:00Z')

    const task = await prisma.task.findFirst({
      where: { subjectId: evictionCase.id, type: 'eviction.scra_search_stale' },
    })
    expect(task).toBeNull()
  })

  it('is idempotent - flags the stale search only once across many days in the window', async () => {
    const { evictionCase, lease, tenant } = await seedCase('h', '2026-09-07T18:00:00Z')
    await seedLookup(lease.id, tenant.id, '2026-07-01')
    await runAt('2026-09-01T12:00:00Z')
    await runAt('2026-09-02T12:00:00Z')
    await runAt('2026-09-03T12:00:00Z')

    const tasks = await prisma.task.findMany({
      where: { subjectId: evictionCase.id, type: 'eviction.scra_search_stale' },
    })
    expect(tasks).toHaveLength(1)
  })
})
