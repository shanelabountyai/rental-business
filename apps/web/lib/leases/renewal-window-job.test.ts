import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation `auto-make-ready.test.ts` already relies on.
import './renewal-window-job.ts'

// LEASE-09 (R-065): "Given a lease inside the renewal window, when the
// window opens, then a renewal task is created."

const CHICAGO = 'America/Chicago'

let entityId: string
let propertyId: string
const unitIds: string[] = []
const leaseIds: string[] = []

beforeAll(async () => {
  const stamp = `renewalwin-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
})

afterEach(async () => {
  await prisma.task.deleteMany({ where: { propertyId } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  leaseIds.length = 0
  unitIds.length = 0
})

afterAll(async () => {
  await prisma.property.delete({ where: { id: propertyId } })
  await prisma.legalEntity.delete({ where: { id: entityId } })
  await prisma.$disconnect()
})

async function makeUnit(name: string) {
  const unit = await prisma.unit.create({ data: { propertyId, name, status: 'OCCUPIED' } })
  unitIds.push(unit.id)
  return unit
}

async function makeLease(unitId: string, endsOn: string | null, status = 'ACTIVE') {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: status as never,
      startsOn: new Date('2026-01-01T00:00:00Z'),
      endsOn: endsOn ? new Date(`${endsOn}T00:00:00Z`) : null,
      rentCents: 150_000,
    },
  })
  leaseIds.push(lease.id)
  return lease
}

async function runAt(isoInstant: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

describe('the renewal-window job', () => {
  it('flags a lease that has entered the 120-day window', async () => {
    const unit = await makeUnit('U1')
    const lease = await makeLease(unit.id, '2026-10-30') // ~119 days from 2026-07-03

    await runAt('2026-07-03T09:00:00Z')

    const task = await prisma.task.findFirst({ where: { type: 'lease_renewal', subjectId: lease.id } })
    expect(task).not.toBeNull()
    expect(task?.title).toContain('120-day')
  })

  it('does not flag a lease still more than 120 days out', async () => {
    const unit = await makeUnit('U2')
    const lease = await makeLease(unit.id, '2027-03-01')

    await runAt('2026-07-03T09:00:00Z')

    const task = await prisma.task.findFirst({ where: { type: 'lease_renewal', subjectId: lease.id } })
    expect(task).toBeNull()
  })

  it('never flags a month-to-month lease (no end date)', async () => {
    const unit = await makeUnit('U3')
    const lease = await makeLease(unit.id, null, 'MONTH_TO_MONTH')

    await runAt('2026-07-03T09:00:00Z')

    const task = await prisma.task.findFirst({ where: { type: 'lease_renewal', subjectId: lease.id } })
    expect(task).toBeNull()
  })

  it('flags once, not again on a later day inside the same window', async () => {
    const unit = await makeUnit('U4')
    const lease = await makeLease(unit.id, '2026-10-30')

    await runAt('2026-07-03T09:00:00Z')
    await runAt('2026-07-04T09:00:00Z')
    await runAt('2026-08-01T09:00:00Z')

    const tasks = await prisma.task.findMany({ where: { type: 'lease_renewal', subjectId: lease.id } })
    expect(tasks).toHaveLength(1)
  })

  it('a lease with an existing renewal task (already closed) is not re-flagged', async () => {
    const unit = await makeUnit('U5')
    const lease = await makeLease(unit.id, '2026-10-30')
    await runAt('2026-07-03T09:00:00Z')
    await prisma.task.updateMany({
      where: { type: 'lease_renewal', subjectId: lease.id },
      data: { status: 'DONE' },
    })

    // A later run, in the still-open window - must not raise a second one.
    await runAt('2026-07-05T09:00:00Z')

    const tasks = await prisma.task.findMany({ where: { type: 'lease_renewal', subjectId: lease.id } })
    expect(tasks).toHaveLength(1)
  })
})
