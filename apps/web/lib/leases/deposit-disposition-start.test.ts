import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { endRenewalPredecessor } from './activate.ts'
import { startDepositDisposition } from './deposit-disposition-start.ts'

// Starting the disposition countdown "from the recorded move-out date"
// (INSP-03, R-071) - frozen once, from `Lease.moveOutAt`, never
// recomputed (D-12).

const STATE = 'XY' // isolated from every other test's own state fixture.
const CHICAGO = 'America/Chicago'
const HELD_CENTS = 200_000

let entityId: string
const propertyIds: string[] = []
const ruleIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []
const depositIds: string[] = []

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `Disposition LLC-${Date.now()}`, type: 'LLC' },
  })
  entityId = entity.id
})

afterEach(async () => {
  await prisma.deposit.deleteMany({ where: { id: { in: depositIds } } })
  await prisma.task.deleteMany({ where: { subjectId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: ruleIds } } })
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } })
  depositIds.length = 0
  leaseIds.length = 0
  tenantIds.length = 0
  unitIds.length = 0
  ruleIds.length = 0
  propertyIds.length = 0
})

afterAll(async () => {
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedProperty() {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `Disposition House-${unique}`,
      addressLine1: '1 Trust Ave',
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

async function seedLease(
  propertyId: string,
  overrides: {
    moveOutAt?: Date | null
    noticeForwardingAddress?: string | null
    deposit?: boolean
    renewedFromLeaseId?: string
  } = {},
) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const unit = await prisma.unit.create({ data: { propertyId, name: `U-${unique}`, status: 'VACANT' } })
  unitIds.push(unit.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ENDED',
      startsOn: new Date('2025-01-01'),
      endsOn: new Date('2026-08-31'),
      rentCents: 150_000,
      depositCents: HELD_CENTS,
      depositArrangement: 'CASH',
      moveOutAt: overrides.moveOutAt === undefined ? new Date('2026-08-31T20:00:00Z') : overrides.moveOutAt,
      noticeForwardingAddress:
        overrides.noticeForwardingAddress === undefined ? '99 Forwarding Ln' : overrides.noticeForwardingAddress,
      renewedFromLeaseId: overrides.renewedFromLeaseId,
    },
  })
  leaseIds.push(lease.id)
  if (overrides.deposit !== false) {
    const deposit = await prisma.deposit.create({
      data: { propertyId, leaseId: lease.id, heldCents: HELD_CENTS, receivedAt: new Date('2025-01-01') },
    })
    depositIds.push(deposit.id)
  }
  return lease
}

async function seedRule(depositDispositionDays: number | null) {
  const rule = await prisma.jurisdictionRule.create({
    data: {
      state: STATE,
      version: 1,
      effectiveFrom: new Date('2020-01-01'),
      graceDays: 0,
      lateFeeType: 'NONE',
      paymentAllocationOrder: [],
      depositDispositionDays,
    },
  })
  ruleIds.push(rule.id)
  return rule
}

describe('startDepositDisposition', () => {
  it('freezes the disposition deadline from moveOutAt and snapshots the forwarding address', async () => {
    await seedRule(30)
    const property = await seedProperty()
    const lease = await seedLease(property.id)

    const result = await startDepositDisposition(lease.id)
    expect(result.reason).toBe('started')

    const deposit = await prisma.deposit.findFirstOrThrow({ where: { leaseId: lease.id } })
    // 2026-08-31 + 30 days.
    expect(deposit.dispositionDueOn?.toISOString().slice(0, 10)).toBe('2026-09-30')
    expect(deposit.forwardingAddress).toBe('99 Forwarding Ln')

    const task = await prisma.task.findFirst({
      where: { subjectId: lease.id, type: 'deposit.disposition_due' },
    })
    expect(task).not.toBeNull()
  })

  // R-169. `moveOutAt` is a real timestamp, so an evening move-out is
  // ALREADY the next calendar day in UTC: 8:30pm Chicago on 31 Aug is
  // 2026-09-01T01:30Z. Reading it with the date-only reader started the
  // statutory clock from 1 Sep and gave the owner a day of deadline that
  // no statute grants - the same defect R-156 fixed on the cure clock.
  it('starts the clock on the property-local move-out day, not the UTC one (R-169)', async () => {
    await seedRule(30)
    const property = await seedProperty()
    const lease = await seedLease(property.id, { moveOutAt: new Date('2026-09-01T01:30:00Z') })

    expect((await startDepositDisposition(lease.id)).reason).toBe('started')

    const deposit = await prisma.deposit.findFirstOrThrow({ where: { leaseId: lease.id } })
    // 2026-08-31 + 30, not 2026-09-01 + 30.
    expect(deposit.dispositionDueOn?.toISOString().slice(0, 10)).toBe('2026-09-30')
    const task = await prisma.task.findFirstOrThrow({
      where: { subjectId: lease.id, type: 'deposit.disposition_due' },
    })
    expect(task.businessDate.toISOString().slice(0, 10)).toBe('2026-08-31')
  })

  it('is a no-op once already started, even if the rule later changes', async () => {
    await seedRule(30)
    const property = await seedProperty()
    const lease = await seedLease(property.id)
    await startDepositDisposition(lease.id)
    const first = await prisma.deposit.findFirstOrThrow({ where: { leaseId: lease.id } })

    const result = await startDepositDisposition(lease.id)
    expect(result.reason).toBe('already_started')

    const after = await prisma.deposit.findFirstOrThrow({ where: { leaseId: lease.id } })
    expect(after.dispositionDueOn).toEqual(first.dispositionDueOn)
  })

  it('starts on a twice-renewed lease - the deposit follows the tenancy through each cutover (R-154)', async () => {
    await seedRule(30)
    const property = await seedProperty()
    // The original tenancy holds the only Deposit row; each renewal cutover
    // re-points it at the successor, so the final lease - the one whose
    // move-out actually happens - is the one the disposition clock reads.
    const original = await seedLease(property.id, { moveOutAt: null })
    const first = await seedLease(property.id, {
      moveOutAt: null,
      deposit: false,
      renewedFromLeaseId: original.id,
    })
    await endRenewalPredecessor(prisma, { predecessorId: original.id, successorId: first.id })
    const second = await seedLease(property.id, { deposit: false, renewedFromLeaseId: first.id })
    await endRenewalPredecessor(prisma, { predecessorId: first.id, successorId: second.id })

    const result = await startDepositDisposition(second.id)
    expect(result.reason).toBe('started')

    const deposit = await prisma.deposit.findFirstOrThrow({ where: { leaseId: second.id } })
    expect(deposit.heldCents).toBe(HELD_CENTS)
    expect(deposit.dispositionDueOn).not.toBeNull()
    // The predecessors hold nothing - one liability row, never a copy.
    expect(await prisma.deposit.count({ where: { leaseId: { in: [original.id, first.id] } } })).toBe(0)
  })

  it('does nothing for a zero-deposit lease', async () => {
    await seedRule(30)
    const property = await seedProperty()
    const lease = await seedLease(property.id, { deposit: false })

    const result = await startDepositDisposition(lease.id)
    expect(result.reason).toBe('no_deposit')
  })

  it('leaves the deadline unset where no depositDispositionDays is configured', async () => {
    await seedRule(null)
    const property = await seedProperty()
    const lease = await seedLease(property.id)

    const result = await startDepositDisposition(lease.id)
    expect(result.reason).toBe('no_rule_configured')

    const deposit = await prisma.deposit.findFirstOrThrow({ where: { leaseId: lease.id } })
    expect(deposit.dispositionDueOn).toBeNull()
  })
})
