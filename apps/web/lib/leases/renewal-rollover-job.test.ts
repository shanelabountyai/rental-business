import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation `auto-make-ready.test.ts` already relies on.
import './renewal-rollover-job.ts'

// LEASE-09 (R-065): "Month-to-month rollovers apply the configured MTM rate
// automatically."

const CHICAGO = 'America/Chicago'

let entityId: string
let propertyId: string
const unitIds: string[] = []
const leaseIds: string[] = []
const tenantIds: string[] = []

beforeAll(async () => {
  const stamp = `mtmroll-${Date.now()}`
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
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  // Notification is append-only by trigger (CLAUDE.md) - nothing here
  // deletes the rows this job's own notify() call writes each run.
  leaseIds.length = 0
  unitIds.length = 0
  tenantIds.length = 0
})

afterAll(async () => {
  const audited = await prisma.auditLog.count({ where: { propertyId } })
  if (audited > 0) {
    await prisma.property.update({ where: { id: propertyId }, data: { active: false } })
  } else {
    await prisma.property.delete({ where: { id: propertyId } })
    await prisma.legalEntity.delete({ where: { id: entityId } })
  }
  await prisma.$disconnect()
})

async function makeUnit(name: string) {
  const unit = await prisma.unit.create({ data: { propertyId, name, status: 'OCCUPIED' } })
  unitIds.push(unit.id)
  return unit
}

async function makeTenant() {
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Pat', lastName: 'Renter', email: `pat-${Date.now()}-${Math.random()}@example.test` },
  })
  tenantIds.push(tenant.id)
  return tenant
}

async function makeLease(
  unitId: string,
  overrides: Partial<{
    endsOn: string
    mtmRentCents: number | null
    rentCents: number
    status: string
    noticeGivenAt: Date
    noticeGivenBy: string
  }> = {},
) {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: (overrides.status ?? 'ACTIVE') as never,
      startsOn: new Date('2026-01-01T00:00:00Z'),
      endsOn: new Date(`${overrides.endsOn ?? '2026-06-30'}T00:00:00Z`),
      rentCents: overrides.rentCents ?? 150_000,
      mtmRentCents: overrides.mtmRentCents,
      noticeGivenAt: overrides.noticeGivenAt,
      noticeGivenBy: overrides.noticeGivenBy as never,
    },
  })
  leaseIds.push(lease.id)
  const tenant = await makeTenant()
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true } })
  return lease
}

async function runAt(isoInstant: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

describe('the MTM auto-rollover job', () => {
  it('rolls an ACTIVE lease to MONTH_TO_MONTH at its configured MTM rate once the term ends', async () => {
    const unit = await makeUnit('U1')
    const lease = await makeLease(unit.id, { endsOn: '2026-06-30', mtmRentCents: 175_000 })

    await runAt('2026-07-02T09:00:00Z')

    const updated = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
    expect(updated.status).toBe('MONTH_TO_MONTH')
    expect(updated.isMonthToMonth).toBe(true)
    expect(updated.rentCents).toBe(175_000)
    expect(updated.endsOn).toBeNull()
  })

  it('falls back to the current rent when no MTM rate is configured', async () => {
    const unit = await makeUnit('U2')
    const lease = await makeLease(unit.id, { endsOn: '2026-06-30', mtmRentCents: null, rentCents: 150_000 })

    await runAt('2026-07-02T09:00:00Z')

    const updated = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
    expect(updated.status).toBe('MONTH_TO_MONTH')
    expect(updated.rentCents).toBe(150_000)
  })

  it('does not roll over while a renewal successor is already in flight', async () => {
    const unit = await makeUnit('U3')
    const lease = await makeLease(unit.id, { endsOn: '2026-06-30', mtmRentCents: 175_000 })
    const successor = await prisma.lease.create({
      data: {
        propertyId,
        unitId: unit.id,
        status: 'DRAFT',
        renewedFromLeaseId: lease.id,
        origin: 'RENEWAL',
        startsOn: new Date('2026-07-01T00:00:00Z'),
        endsOn: new Date('2027-06-30T00:00:00Z'),
        rentCents: 160_000,
      },
    })
    leaseIds.push(successor.id)

    await runAt('2026-07-02T09:00:00Z')

    const updated = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
    expect(updated.status).toBe('ACTIVE')
  })

  it('does not roll over a lease under notice - R-066: a declared non-renewal or notice to vacate must not be silently overridden', async () => {
    const unit = await makeUnit('U6')
    const lease = await makeLease(unit.id, {
      endsOn: '2026-06-30',
      mtmRentCents: 175_000,
      noticeGivenAt: new Date('2026-05-01T00:00:00Z'),
      noticeGivenBy: 'LANDLORD',
    })

    await runAt('2026-07-02T09:00:00Z')

    const updated = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
    expect(updated.status).toBe('ACTIVE')
  })

  it('does not fire the day the term ends, only once it has actually passed', async () => {
    const unit = await makeUnit('U4')
    const lease = await makeLease(unit.id, { endsOn: '2026-07-02' })

    await runAt('2026-07-02T09:00:00Z')

    const updated = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
    expect(updated.status).toBe('ACTIVE')
  })

  it('writes an audit entry with the before/after rent', async () => {
    const unit = await makeUnit('U5')
    const lease = await makeLease(unit.id, { endsOn: '2026-06-30', mtmRentCents: 175_000, rentCents: 150_000 })

    await runAt('2026-07-02T09:00:00Z')

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'lease.rolled_to_month_to_month', entityId: lease.id },
    })
    expect(entry).not.toBeNull()
    expect(entry?.actorType).toBe('SYSTEM')
    expect(entry?.before).toMatchObject({ rentCents: 150_000 })
    expect(entry?.after).toMatchObject({ rentCents: 175_000 })
  })
})

// R-225 follow-up: the MTM rate is pre-agreed, but a statutory cap is a
// ceiling whatever the lease says. Own state code and rule - `rulesFor`
// reads every rule for a state, so the TX property above must not see a cap.
describe('the MTM auto-rollover job against a rent-increase cap', () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const state = Array.from({ length: 2 }, () => letters[Math.floor(Math.random() * 26)]).join('')
  let capEntityId: string
  let capPropertyId: string
  let capRuleId: string
  let capUnitId: string
  let capLeaseId: string

  afterAll(async () => {
    await prisma.leaseTenant.deleteMany({ where: { leaseId: capLeaseId } })
    await prisma.lease.deleteMany({ where: { id: capLeaseId } })
    await prisma.unit.deleteMany({ where: { id: capUnitId } })
    await prisma.jobRun.deleteMany({ where: { propertyId: capPropertyId } })
    await prisma.jurisdictionRule.update({
      where: { id: capRuleId },
      data: { effectiveTo: new Date('2020-01-02') },
    })
    // Audit and Task rows reference the property, so it is retired, not deleted.
    await prisma.property.update({ where: { id: capPropertyId }, data: { active: false } })
    await prisma.legalEntity.update({ where: { id: capEntityId }, data: { active: false } })
  })

  it('rolls at the highest lawful rent and opens a task when the MTM rate is over the cap', async () => {
    const stamp = `mtmcap-${Date.now()}`
    capEntityId = (await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })).id
    capPropertyId = (
      await prisma.property.create({
        data: {
          legalEntityId: capEntityId,
          name: stamp,
          addressLine1: '2 Test St',
          city: 'Houston',
          state,
          postalCode: '77002',
          timezone: CHICAGO,
          propertyType: 'SINGLE_FAMILY',
        },
      })
    ).id
    capRuleId = (
      await prisma.jurisdictionRule.create({
        data: {
          state,
          jurisdiction: null,
          version: 1,
          effectiveFrom: new Date('2020-01-01'),
          graceDays: 3,
          lateFeeType: 'NONE',
          depositEscrowRequired: false,
          depositInterestRequired: false,
          justCauseRequired: false,
          paymentAllocationOrder: ['RENT'],
          rubsPermitted: true,
          rentIncreaseCapPercentBps: 500,
        },
      })
    ).id
    capUnitId = (
      await prisma.unit.create({ data: { propertyId: capPropertyId, name: 'C1', status: 'OCCUPIED' } })
    ).id
    const lease = await prisma.lease.create({
      data: {
        propertyId: capPropertyId,
        unitId: capUnitId,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01T00:00:00Z'),
        endsOn: new Date('2026-06-30T00:00:00Z'),
        rentCents: 150_000,
        mtmRentCents: 175_000,
      },
    })
    capLeaseId = lease.id

    await runDueJobs(new Date('2026-07-02T09:00:00Z'), { propertyIds: [capPropertyId] })

    // 5% over $1,500 is $1,575, not the $1,750 the lease agreed.
    const updated = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
    expect(updated.status).toBe('MONTH_TO_MONTH')
    expect(updated.rentCents).toBe(157_500)
    const tasks = await prisma.task.findMany({ where: { propertyId: capPropertyId, type: 'mtm_rate_capped' } })
    expect(tasks).toHaveLength(1)
  })
})
