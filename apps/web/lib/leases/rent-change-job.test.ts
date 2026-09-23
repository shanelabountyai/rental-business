import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS, same isolation `renewal-cutover-job.test.ts` relies on.
import './rent-change-job.ts'
import { notifyRentIncreaseWithdrawn } from './rent-increase-withdrawn.ts'

// R-225 (LEASE-09): a scheduled rent increase reaches the lease - and so
// Stripe - on its effective date only when its notice was served in time.
// The period is judged from the notice's real `servedAt`, not from the day
// the increase was typed.
//
// Nothing is deleted afterwards: `Notice` is append-only, and every lease
// here is referenced by one. The property is retired instead.

const CHICAGO = 'America/Chicago'
// This file's own state code - `rulesFor` reads every rule for a state, so a
// code shared with another file lets one file's rule mask the other's
// (CLAUDE.md's magic-fixture trap).
const STATE = 'Q7'

let entityId: string
let propertyId: string
let ruleId: string

beforeAll(async () => {
  const stamp = `rentchg-${randomUUID().slice(0, 8)}`
  entityId = (await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })).id
  propertyId = (
    await prisma.property.create({
      data: {
        legalEntityId: entityId,
        name: stamp,
        addressLine1: '1 Test St',
        city: 'Houston',
        state: STATE,
        postalCode: '77002',
        timezone: CHICAGO,
        propertyType: 'SINGLE_FAMILY',
      },
    })
  ).id
  ruleId = (
    await prisma.jurisdictionRule.create({
      data: {
        state: STATE,
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
        rentIncreaseNoticeDays: 30,
      },
    })
  ).id
})

afterAll(async () => {
  await prisma.property.update({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.update({ where: { id: entityId }, data: { active: false } })
  await prisma.jurisdictionRule.update({ where: { id: ruleId }, data: { effectiveTo: new Date('2020-01-02') } }).catch(() => {})
  await prisma.$disconnect()
})

/** A running lease at $1,500 with an increase to $1,600 scheduled for 1 July. */
async function scheduled(opts: { servedAt: Date | null; overrideReason?: string; rentCents?: number }) {
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 4)}`, status: 'OCCUPIED' },
  })
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'MONTH_TO_MONTH',
      isMonthToMonth: true,
      startsOn: new Date('2025-01-01T00:00:00Z'),
      rentCents: opts.rentCents ?? 150_000,
    },
  })
  const notice = await prisma.notice.create({
    data: {
      propertyId,
      leaseId: lease.id,
      type: 'RENT_INCREASE',
      addressOfRecord: '1 Test St',
      bodyText: 'x',
      serviceMethod: opts.servedAt ? 'PERSONAL' : null,
      servedAt: opts.servedAt,
    },
  })
  const change = await prisma.rentChange.create({
    data: {
      leaseId: lease.id,
      propertyId,
      fromCents: 150_000,
      toCents: 160_000,
      effectiveOn: new Date('2026-07-01T00:00:00Z'),
      noticeId: notice.id,
      overrideReason: opts.overrideReason ?? null,
    },
  })
  return { lease, change }
}

async function state(leaseId: string, changeId: string) {
  const [lease, change] = await Promise.all([
    prisma.lease.findUniqueOrThrow({ where: { id: leaseId } }),
    prisma.rentChange.findUniqueOrThrow({ where: { id: changeId } }),
  ])
  return { rentCents: lease.rentCents, status: change.status, heldReason: change.heldReason }
}

describe('the rent-increase cutover', () => {
  // All five cases in one run, because the job runs once per property per
  // local day - a second `runDueJobs` for the same day is a no-op.
  it('applies only an increase whose notice was served in time, and holds the rest with a task', async () => {
    // Served 1 May: 61 days before 1 July, clear of the 30 required.
    const inTime = await scheduled({ servedAt: new Date('2026-05-01T15:00:00Z') })
    // Never served.
    const unserved = await scheduled({ servedAt: null })
    // Served 20 June: 11 days. The form would have passed it on the day it
    // was typed; the service date is what counts.
    const late = await scheduled({ servedAt: new Date('2026-06-20T15:00:00Z') })
    // Same late service, but staff recorded why they proceeded short.
    const overridden = await scheduled({
      servedAt: new Date('2026-06-20T15:00:00Z'),
      overrideReason: 'Tenant agreed in writing to the earlier date.',
    })
    // Rent was edited by hand after the increase was scheduled.
    const edited = await scheduled({ servedAt: new Date('2026-05-01T15:00:00Z'), rentCents: 140_000 })
    // Not yet due: the day before.
    const early = await prisma.rentChange.update({
      where: { id: (await scheduled({ servedAt: new Date('2026-05-01T15:00:00Z') })).change.id },
      data: { effectiveOn: new Date('2026-07-02T00:00:00Z') },
    })

    // 03:30 CDT on 1 July.
    await runDueJobs(new Date('2026-07-01T08:30:00Z'), { propertyIds: [propertyId] })

    expect(await state(inTime.lease.id, inTime.change.id)).toMatchObject({ rentCents: 160_000, status: 'APPLIED' })
    expect(await state(overridden.lease.id, overridden.change.id)).toMatchObject({
      rentCents: 160_000,
      status: 'APPLIED',
    })
    expect(await state(unserved.lease.id, unserved.change.id)).toMatchObject({
      rentCents: 150_000,
      status: 'HELD',
      heldReason: 'The rent increase notice was never served.',
    })
    const lateState = await state(late.lease.id, late.change.id)
    expect(lateState).toMatchObject({ rentCents: 150_000, status: 'HELD' })
    expect(lateState.heldReason).toContain('20 Jun 2026')
    expect(lateState.heldReason).toContain('of the 30 days required')
    expect(await state(edited.lease.id, edited.change.id)).toMatchObject({ rentCents: 140_000, status: 'HELD' })
    expect((await prisma.rentChange.findUniqueOrThrow({ where: { id: early.id } })).status).toBe('SCHEDULED')

    const tasks = await prisma.task.findMany({
      where: { type: 'rent_increase_held', propertyId },
      select: { subjectId: true, priority: true },
    })
    expect(tasks.map((t) => t.subjectId).sort()).toEqual(
      [unserved.lease.id, late.lease.id, edited.lease.id].sort(),
    )
    expect(tasks.every((t) => t.priority === 'URGENT')).toBe(true)
  })
})

describe('telling the tenant an increase was withdrawn', () => {
  async function withTenant(servedAt: Date | null) {
    const made = await scheduled({ servedAt })
    const tenant = await prisma.tenant.create({
      data: { firstName: 'Pat', lastName: 'Renter', email: `pat-${randomUUID()}@example.test` },
    })
    await prisma.leaseTenant.create({ data: { leaseId: made.lease.id, tenantId: tenant.id, isPrimary: true } })
    return made.change
  }
  const sent = (changeId: string) =>
    prisma.notification.count({ where: { idempotencyKey: { startsWith: `rent-increase-withdrawn:${changeId}` } } })

  it('notifies a tenant who was served, and stays silent for one who never was', async () => {
    const served = await withTenant(new Date('2026-05-01T15:00:00Z'))
    const unserved = await withTenant(null)

    await notifyRentIncreaseWithdrawn(served.id)
    await notifyRentIncreaseWithdrawn(unserved.id)

    expect(await sent(served.id)).toBeGreaterThan(0)
    expect(await sent(unserved.id)).toBe(0)
  })
})
