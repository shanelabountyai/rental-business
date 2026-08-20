import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation every other job test in this codebase
// relies on.
import './deposit-disposition-reminder-job.ts'

// Escalating reminders on the deposit-disposition deadline (INSP-03, R-071):
// a ROUTINE flag once the window is half elapsed, a URGENT flag once it is
// overdue, each raised exactly once regardless of how many days the job
// keeps re-checking a still-open disposition.

const CHICAGO = 'America/Chicago'

let entityId: string
let propertyId: string
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []
const depositIds: string[] = []

beforeAll(async () => {
  const stamp = `dispreminder-${Date.now()}`
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
  await prisma.deposit.deleteMany({ where: { id: { in: depositIds } } })
  await prisma.task.deleteMany({ where: { subjectId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  depositIds.length = 0
  leaseIds.length = 0
  tenantIds.length = 0
  unitIds.length = 0
})

afterAll(async () => {
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedDeposit(unique: string, moveOutOn: string, dueOn: string) {
  const unit = await prisma.unit.create({ data: { propertyId, name: `U-${unique}`, status: 'VACANT' } })
  unitIds.push(unit.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ENDED',
      startsOn: new Date('2025-01-01'),
      rentCents: 150_000,
      moveOutAt: new Date(`${moveOutOn}T20:00:00Z`),
    },
  })
  leaseIds.push(lease.id)
  const deposit = await prisma.deposit.create({
    data: {
      propertyId,
      leaseId: lease.id,
      heldCents: 200_000,
      dispositionDueOn: new Date(`${dueOn}T00:00:00Z`),
    },
  })
  depositIds.push(deposit.id)
  return { lease, deposit }
}

async function runAt(isoInstant: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

describe('the deposit-disposition reminder job', () => {
  it('flags halfway once the window is half elapsed', async () => {
    // 30-day window (Aug 1 -> Aug 31), 16 days elapsed = past halfway.
    const { lease } = await seedDeposit('a', '2026-08-01', '2026-08-31')
    await runAt('2026-08-17T12:00:00Z')

    const task = await prisma.task.findFirst({
      where: { subjectId: lease.id, type: 'deposit.disposition_halfway' },
    })
    expect(task?.priority).toBe('ROUTINE')
    const overdue = await prisma.task.findFirst({
      where: { subjectId: lease.id, type: 'deposit.disposition_overdue' },
    })
    expect(overdue).toBeNull()
  })

  it('leaves an early disposition alone, well before halfway', async () => {
    const { lease } = await seedDeposit('b', '2026-08-01', '2026-08-31')
    await runAt('2026-08-03T12:00:00Z')

    const task = await prisma.task.findFirst({ where: { subjectId: lease.id } })
    expect(task).toBeNull()
  })

  it('flags overdue once the deadline has passed', async () => {
    const { lease } = await seedDeposit('c', '2026-08-01', '2026-08-31')
    await runAt('2026-09-05T12:00:00Z')

    const task = await prisma.task.findFirst({
      where: { subjectId: lease.id, type: 'deposit.disposition_overdue' },
    })
    expect(task?.priority).toBe('URGENT')
  })

  it('never flags a disposition already finalized', async () => {
    const { lease, deposit } = await seedDeposit('d', '2026-08-01', '2026-08-31')
    await prisma.deposit.update({ where: { id: deposit.id }, data: { dispositionSentAt: new Date() } })
    await runAt('2026-09-05T12:00:00Z')

    const task = await prisma.task.findFirst({ where: { subjectId: lease.id } })
    expect(task).toBeNull()
  })

  it('is idempotent - flags halfway only once across many days', async () => {
    const { lease } = await seedDeposit('e', '2026-08-01', '2026-08-31')
    await runAt('2026-08-17T12:00:00Z')
    await runAt('2026-08-18T12:00:00Z')
    await runAt('2026-08-19T12:00:00Z')

    const tasks = await prisma.task.findMany({
      where: { subjectId: lease.id, type: 'deposit.disposition_halfway' },
    })
    expect(tasks).toHaveLength(1)
  })
})
