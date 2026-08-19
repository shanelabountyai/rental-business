import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation `auto-make-ready.test.ts` already relies on.
import './renter-insurance-job.ts'

// LEASE-10 (R-067): expiry/lapse alerts on a lease's own renter's-insurance
// certificate.

const CHICAGO = 'America/Chicago'

let entityId: string
let propertyId: string
const unitIds: string[] = []
const leaseIds: string[] = []
const policyIds: string[] = []

beforeAll(async () => {
  const stamp = `renterins-${Date.now()}`
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
  await prisma.renterInsurancePolicy.deleteMany({ where: { id: { in: policyIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  policyIds.length = 0
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

async function makeLease(unitId: string, status = 'ACTIVE') {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: status as never,
      startsOn: new Date('2026-01-01T00:00:00Z'),
      endsOn: new Date('2026-12-31T00:00:00Z'),
      rentCents: 150_000,
    },
  })
  leaseIds.push(lease.id)
  return lease
}

async function makePolicy(leaseId: string, expiresOn: string | null) {
  const policy = await prisma.renterInsurancePolicy.create({
    data: { leaseId, carrier: 'Acme Mutual', expiresOn: expiresOn ? new Date(`${expiresOn}T00:00:00Z`) : null },
  })
  policyIds.push(policy.id)
  return policy
}

async function runAt(isoInstant: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

describe('the renter-insurance-check job', () => {
  it('flags an expiring-soon policy (within 60 days)', async () => {
    const unit = await makeUnit('U1')
    const lease = await makeLease(unit.id)
    const policy = await makePolicy(lease.id, '2026-08-20') // ~18 days from 2026-08-02

    await runAt('2026-08-02T11:00:00Z')

    const task = await prisma.task.findFirst({ where: { type: 'renter_insurance_expiring', subjectId: policy.id } })
    expect(task).not.toBeNull()
    expect(task?.priority).toBe('ROUTINE')
  })

  it('flags a lapsed policy as URGENT', async () => {
    const unit = await makeUnit('U2')
    const lease = await makeLease(unit.id)
    const policy = await makePolicy(lease.id, '2026-07-01')

    await runAt('2026-08-02T11:00:00Z')

    const task = await prisma.task.findFirst({ where: { type: 'renter_insurance_lapsed', subjectId: policy.id } })
    expect(task).not.toBeNull()
    expect(task?.priority).toBe('URGENT')
  })

  it('does not flag a policy that is comfortably current', async () => {
    const unit = await makeUnit('U3')
    const lease = await makeLease(unit.id)
    const policy = await makePolicy(lease.id, '2027-06-01')

    await runAt('2026-08-02T11:00:00Z')

    const tasks = await prisma.task.findMany({ where: { subjectId: policy.id } })
    expect(tasks).toHaveLength(0)
  })

  it('does not flag a lease with no policy on file at all', async () => {
    const unit = await makeUnit('U4')
    const lease = await makeLease(unit.id)

    const result = await runAt('2026-08-02T11:00:00Z')

    expect(result.filter((r) => r.jobType === 'lease.renter_insurance_check')[0]?.outcome).toBe('ran')
    expect(await prisma.task.count({ where: { subjectType: 'Lease', subjectId: lease.id } })).toBe(0)
  })

  it('flags once, not again on a later day', async () => {
    const unit = await makeUnit('U5')
    const lease = await makeLease(unit.id)
    const policy = await makePolicy(lease.id, '2026-07-01')

    await runAt('2026-08-02T11:00:00Z')
    await runAt('2026-08-03T11:00:00Z')

    const tasks = await prisma.task.findMany({ where: { type: 'renter_insurance_lapsed', subjectId: policy.id } })
    expect(tasks).toHaveLength(1)
  })

  it('the newest policy on the lease is the one checked, not an older superseded one', async () => {
    const unit = await makeUnit('U6')
    const lease = await makeLease(unit.id)
    await makePolicy(lease.id, '2026-07-01') // lapsed - but superseded below
    const current = await makePolicy(lease.id, '2027-06-01') // current

    await runAt('2026-08-02T11:00:00Z')

    expect(await prisma.task.count({ where: { subjectId: current.id } })).toBe(0)
  })
})
