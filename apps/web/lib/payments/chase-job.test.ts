import { randomUUID } from 'node:crypto'
import { CHASE_LADDER_DAYS } from '@rental/core/ledger'
import { businessDate, businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findScheduledJob, runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation every other job test in this codebase
// relies on.
import './chase-job.ts'

// The delinquency ladder (PAY-06; R-179).
//
// ==========================================================================
// THE SWEEP, NOT THE ARITHMETIC. packages/core/ledger/aging.test.ts already
// proves `chaseRungDue` counts from the end of grace and fires on the rung
// day only. What cannot be proved there is that a real tenancy, in a real
// state with a real seeded rule, raises exactly the tasks the ladder names -
// and that a tenancy under a `halt_dunning` hold raises none at all.
//
// THE GRACE PERIOD IS READ, NOT ASSUMED. Texas's seeded rule is one day
// today. Hard-coding that would make every date below a lie the moment the
// rule is re-versioned, and the failure would read as a broken ladder rather
// than as a changed statute - which is the mistake rent-roll.spec.ts's own
// header records making.
// ==========================================================================

const CHICAGO = 'America/Chicago'
/// Mid-afternoon UTC, so the property's local clock is past the job's 08:00
/// whether Chicago is on CST or CDT, and the local calendar day is still the
/// one the instant names.
const AFTERNOON = 'T20:00:00Z'

let entityId: string
let propertyId: string
let graceDays: number
let staffId: string
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

beforeAll(async () => {
  const stamp = `chasejob-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '7 Arrears Avenue',
      city: 'Houston',
      // TEXAS, because R-010 seeds its rule with a real grace period. A state
      // with no rule is `graceDays: null`, which is never chaseable at all
      // (D-4) - the whole ladder would be untestable.
      state: 'TX',
      postalCode: '77002',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id

  const rule = await prisma.jurisdictionRule.findFirstOrThrow({
    where: { state: 'TX', jurisdiction: null },
    orderBy: { version: 'desc' },
  })
  graceDays = rule.graceDays ?? 0

  const staff = await prisma.staffUser.create({
    data: { email: `chasejob-${randomUUID()}@example.test`, name: 'Hold Placer' },
  })
  staffId = staff.id
})

afterEach(async () => {
  // BY OWNERSHIP, not by a collected-id list of what the app wrote.
  await prisma.task.deleteMany({ where: { propertyId } })
  await prisma.leaseHold.deleteMany({ where: { propertyId } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
})

afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.unit.updateMany({ where: { id: { in: unitIds } }, data: { status: 'DOWN' } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

/// A tenancy owing one month's rent, due on the 1st of `month`.
async function seedArrears(month: string) {
  const stamp = randomUUID().slice(0, 8)
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Ari', lastName: `Chase-${stamp}` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date(`${month}-01`),
      rentCents: 150_000,
      rentDueDay: 1,
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  await prisma.ledgerEntry.create({
    data: {
      propertyId,
      leaseId: lease.id,
      type: 'CHARGE',
      amountCents: 150_000,
      description: 'Rent',
      occurredAt: new Date(`${month}-01${AFTERNOON}`),
    },
  })
  return lease.id
}

/// `YYYY-MM-DD`, `rung` days past the END of grace on a rent due date.
function dayOfRung(month: string, rung: number): string {
  const due = businessDateToUtc(`${month}-01`)
  due.setUTCDate(due.getUTCDate() + graceDays + rung)
  return due.toISOString().slice(0, 10)
}

/// Runs the job for this property on one property-local day, WITHOUT the
/// runner's catch-up. `runDueJobs` replays up to three missed business dates
/// (CATCH_UP_BUSINESS_DAYS), which would silently fire yesterday's rung while
/// a test was asserting today's - the registration test below is where the
/// real runner is exercised.
async function runOn(day: string) {
  const job = findScheduledJob('payments.chase')
  if (!job) throw new Error('payments.chase is not registered')
  return job.run({
    propertyId,
    timezone: CHICAGO,
    businessDate: day as never,
    now: new Date(`${day}${AFTERNOON}`),
  })
}

async function chaseTasks(leaseId: string) {
  return prisma.task.findMany({ where: { subjectId: leaseId, type: 'rent.chase' } })
}

describe('the chase ladder sweep', () => {
  it('raises nothing while the tenancy is still inside its grace period', async () => {
    const leaseId = await seedArrears('2026-03')
    // The day grace runs out is rung 1; the day before it is still inside.
    const due = businessDateToUtc('2026-03-01')
    due.setUTCDate(due.getUTCDate() + graceDays)
    await runOn(due.toISOString().slice(0, 10))

    expect(await chaseTasks(leaseId)).toHaveLength(0)
  })

  it('raises one task on each rung and nothing on the days between', async () => {
    const leaseId = await seedArrears('2026-03')

    // Every rung day, and every day in between up to the last rung.
    const last = CHASE_LADDER_DAYS[CHASE_LADDER_DAYS.length - 1]!
    for (let rung = 1; rung <= last + 1; rung++) {
      await runOn(dayOfRung('2026-03', rung))
    }

    const tasks = await chaseTasks(leaseId)
    // THREE, not sixteen. A `>=` ladder would raise one every day the balance
    // stayed unpaid, which is not a ladder, it is a queue nobody can clear.
    expect(tasks).toHaveLength(CHASE_LADDER_DAYS.length)
    // The last rung is the one that usually precedes a notice.
    expect(tasks.filter((task) => task.priority === 'URGENT')).toHaveLength(1)
    expect(tasks.every((task) => task.subjectType === 'Lease')).toBe(true)
  })

  it('RAISES NOTHING UNDER A HOLD THAT STOPS THE CHASE', async () => {
    // R-084: under a bankruptcy stay the debt is still owed and still aged.
    // What stops is the asking - and a Task telling somebody to ask is the
    // asking.
    const leaseId = await seedArrears('2026-03')
    await prisma.leaseHold.create({
      data: {
        leaseId,
        propertyId,
        type: 'BANKRUPTCY',
        reason: 'test fixture',
        placedByStaffId: staffId,
      },
    })

    await runOn(dayOfRung('2026-03', 1))
    expect(await chaseTasks(leaseId)).toHaveLength(0)
  })

  it('raises nothing for a tenancy that owes nothing', async () => {
    const leaseId = await seedArrears('2026-03')
    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId,
        type: 'PAYMENT',
        amountCents: -150_000,
        description: 'Paid in full',
        occurredAt: new Date(`2026-03-02${AFTERNOON}`),
      },
    })

    await runOn(dayOfRung('2026-03', 1))
    expect(await chaseTasks(leaseId)).toHaveLength(0)
  })

  it('is registered with the real runner, and is idempotent per day', async () => {
    // The rung tests above call `run` directly to dodge the catch-up window.
    // This one goes through `runDueJobs`, because a job nobody registered
    // passes every direct test and never runs in production.
    const leaseId = await seedArrears('2026-04')
    const day = dayOfRung('2026-04', 1)
    const at = new Date(`${day}${AFTERNOON}`)
    expect(businessDate(at, CHICAGO)).toBe(day)

    await runDueJobs(at, { propertyIds: [propertyId] })
    const afterFirst = await chaseTasks(leaseId)
    expect(afterFirst.length).toBeGreaterThan(0)

    await prisma.jobRun.deleteMany({ where: { propertyId } })
    await runDueJobs(at, { propertyIds: [propertyId] })
    // The Task's own unique index on (type, subjectId, businessDate) is what
    // holds here, not the JobRun row - deleted above precisely so this is
    // asserting the task's idempotency rather than the runner's.
    expect(await chaseTasks(leaseId)).toHaveLength(afterFirst.length)
  })
})
