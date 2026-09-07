import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation every other job test in this codebase
// relies on.
import './payment-plan-job.ts'

// The break condition (PAY-08, PAY-12; R-175).
//
// ==========================================================================
// THE SWEEP, NOT THE ARITHMETIC. packages/core/payments/plan.test.ts already
// asserts the schedule and the on-track/broken/completed decision; what
// cannot be proved there is that a real plan on a real tenancy actually gets
// broken, that its hold actually comes off, and that the payments counted
// are the ones that stayed.
//
// That last one is the failure worth a database test. `paidTowardPlan`
// classifies a REVERSAL by its sign, and if it got that backwards a bounced
// cheque would keep a plan alive - which is a chase switched off for a
// tenancy that has paid nothing, silently, for as long as the schedule runs.
// ==========================================================================

const CHICAGO = 'America/Chicago'

let entityId: string
let propertyId: string
let staffId: string
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

beforeAll(async () => {
  const stamp = `planjob-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '4 Instalment Row',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const staff = await prisma.staffUser.create({
    data: { email: `planjob-${randomUUID()}@example.test`, name: 'Plan Agreer' },
  })
  staffId = staff.id
})

afterEach(async () => {
  // BY OWNERSHIP, not by a collected-id list of what the app wrote. Every
  // operational row here carries the propertyId, and a failing assertion
  // must not orphan the rows created after it.
  await prisma.task.deleteMany({ where: { propertyId } })
  await prisma.leaseHold.deleteMany({ where: { propertyId } })
  await prisma.paymentPlan.deleteMany({ where: { propertyId } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  // LedgerEntry is append-only by trigger, so the leases and units it points
  // at stay. They are retired in afterAll with the property.
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

/// A tenancy carrying a $900 plan of three $300 instalments on the 1st of
/// March, April and May, with the hold the real action would have placed.
async function seedPlan() {
  const stamp = randomUUID().slice(0, 8)
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Robin', lastName: `Plan-${stamp}` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
      rentDueDay: 1,
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })

  const plan = await prisma.paymentPlan.create({
    data: {
      leaseId: lease.id,
      propertyId,
      arrearsCents: 900_00,
      startedOn: new Date('2026-02-15T00:00:00Z'),
      note: 'test fixture',
      createdByStaffId: staffId,
      instalments: {
        create: [
          { sequence: 1, dueOn: new Date('2026-03-01T00:00:00Z'), amountCents: 300_00 },
          { sequence: 2, dueOn: new Date('2026-04-01T00:00:00Z'), amountCents: 300_00 },
          { sequence: 3, dueOn: new Date('2026-05-01T00:00:00Z'), amountCents: 300_00 },
        ],
      },
    },
  })
  const hold = await prisma.leaseHold.create({
    data: {
      leaseId: lease.id,
      propertyId,
      type: 'PAYMENT_PLAN',
      reason: 'test fixture',
      placedByStaffId: staffId,
      paymentPlanId: plan.id,
    },
  })
  return { leaseId: lease.id, planId: plan.id, holdId: hold.id }
}

async function pay(leaseId: string, amountCents: number, on: string) {
  await prisma.ledgerEntry.create({
    data: {
      propertyId,
      leaseId,
      type: 'PAYMENT',
      // Negative: a payment reduces what is owed. The sign is the whole
      // convention this ledger runs on.
      amountCents: -amountCents,
      description: 'Instalment',
      occurredAt: new Date(`${on}T15:00:00Z`),
    },
  })
}

async function runAt(isoInstant: string) {
  const summaries = await runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
  // A job that THREW is recorded as `failed` and reads, from every assertion
  // below, exactly like a job that decided to do nothing. Surfacing it here
  // is what turns "expected BROKEN, got ACTIVE" back into the stack trace it
  // actually was.
  const failed = summaries.filter((summary) => summary.outcome === 'failed')
  if (failed.length > 0) throw new Error(failed.map((summary) => summary.error).join('\n'))
  return summaries
}

describe('the payment-plan sweep', () => {
  it('leaves a plan alone while its instalments are being paid', async () => {
    const { leaseId, planId, holdId } = await seedPlan()
    await pay(leaseId, 300_00, '2026-03-01')
    await runAt('2026-04-01T13:00:00Z')

    expect((await prisma.paymentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'ACTIVE',
    )
    expect((await prisma.leaseHold.findUniqueOrThrow({ where: { id: holdId } })).liftedAt).toBeNull()
    expect(await prisma.task.findFirst({ where: { subjectId: leaseId } })).toBeNull()
  })

  it('holds through the grace days and breaks the day after', async () => {
    const { leaseId, planId, holdId } = await seedPlan()

    // 06:00 local on the 4th of March is still inside the three-day slack.
    await runAt('2026-03-04T13:00:00Z')
    expect((await prisma.paymentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'ACTIVE',
    )

    await runAt('2026-03-05T13:00:00Z')
    const plan = await prisma.paymentPlan.findUniqueOrThrow({ where: { id: planId } })
    expect(plan.status).toBe('BROKEN')
    // The instalment it broke ON, not the day the sweep noticed.
    expect(plan.brokenOn?.toISOString().slice(0, 10)).toBe('2026-03-01')

    const hold = await prisma.leaseHold.findUniqueOrThrow({ where: { id: holdId } })
    expect(hold.liftedAt).not.toBeNull()
    // NOBODY decided this. An instalment date passed.
    expect(hold.liftedByStaffId).toBeNull()

    const task = await prisma.task.findFirstOrThrow({
      where: { subjectId: leaseId, type: 'payment_plan.broken' },
    })
    expect(task.priority).toBe('URGENT')
  })

  it('does NOT count a payment the bank took back', async () => {
    const { leaseId, planId } = await seedPlan()
    await pay(leaseId, 300_00, '2026-03-01')
    // The reversal is POSITIVE - it puts the debt back - which is the only
    // thing distinguishing it from a reversal of a charge.
    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId,
        type: 'REVERSAL',
        amountCents: 300_00,
        description: 'Payment returned by the bank',
        occurredAt: new Date('2026-03-03T15:00:00Z'),
      },
    })

    await runAt('2026-03-05T13:00:00Z')
    expect((await prisma.paymentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'BROKEN',
    )
  })

  it('ignores money that arrived before the plan started', async () => {
    const { leaseId, planId } = await seedPlan()
    // Paid in January, long before the plan was agreed on 15 February. It
    // cleared an older debt; it is not an instalment on this schedule.
    await pay(leaseId, 900_00, '2026-01-10')

    await runAt('2026-03-05T13:00:00Z')
    expect((await prisma.paymentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'BROKEN',
    )
  })

  it('completes a plan paid in full, and lifts its hold too', async () => {
    const { leaseId, planId, holdId } = await seedPlan()
    await pay(leaseId, 900_00, '2026-03-01')
    await runAt('2026-03-05T13:00:00Z')

    expect((await prisma.paymentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'COMPLETED',
    )
    // The hold comes off here too, and that is the point of the task beside
    // it: dunning silently resuming against somebody who did everything they
    // agreed to is exactly the surprise this should not spring.
    expect(
      (await prisma.leaseHold.findUniqueOrThrow({ where: { id: holdId } })).liftedAt,
    ).not.toBeNull()
    const task = await prisma.task.findFirstOrThrow({
      where: { subjectId: leaseId, type: 'payment_plan.completed' },
    })
    expect(task.priority).toBe('ROUTINE')
  })

  it('breaks a plan exactly once however many days the sweep keeps running', async () => {
    const { leaseId, planId } = await seedPlan()
    await runAt('2026-03-05T13:00:00Z')
    await runAt('2026-03-06T13:00:00Z')
    await runAt('2026-03-07T13:00:00Z')

    // The status filter is what makes it idempotent: a BROKEN plan is no
    // longer ACTIVE, so the second day's sweep does not see it at all.
    expect((await prisma.paymentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'BROKEN',
    )
    const tasks = await prisma.task.findMany({
      where: { subjectId: leaseId, type: 'payment_plan.broken' },
    })
    expect(tasks).toHaveLength(1)
  })
})
