import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allocateBill } from './rubs.ts'

// Charging a utility bill on to the tenants (PAY-08, R-042; D-4, D-12).
//
// The arithmetic is unit-tested in packages/core/billing/rubs.test.ts. What
// is asserted here is the wiring: that the jurisdiction gate is actually
// consulted, that the charge carries the bill it came from, and that a bill
// cannot be split twice.
//
// Its own state, its own JurisdictionRule. Two properties in two states,
// because the whole point of the gate is that the answer differs by state -
// and a test that only ever ran in Texas could not tell whether the rule was
// read at all.

// TWO INVENTED STATES, not Texas. The shipped Texas rule permits RUBS, so a
// test that used it could not tell the gate was read at all - and adding a
// second TX rule would change what every other spec's `rulesFor('TX')`
// resolves to. `XA` permits, `XB` forbids, and both are deleted afterwards.
const PERMITTED_STATE = 'XA'
const FORBIDDEN_STATE = 'XB'

let entityId: string
let permittedPropertyId: string
let forbiddenPropertyId: string
let tenantId: string
const ruleIds: string[] = []

async function seedProperty(state: string, unitSpecs: { name: string; squareFeet: number | null; occupied: boolean }[]) {
  const stamp = `rubs-${state}-${randomUUID().slice(0, 8)}`
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '1 Meter Lane',
      city: 'Houston',
      state,
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'FOURPLEX',
    },
  })
  for (const spec of unitSpecs) {
    const unit = await prisma.unit.create({
      data: {
        propertyId: property.id,
        name: spec.name,
        squareFeet: spec.squareFeet,
        bedrooms: 2,
        status: spec.occupied ? 'OCCUPIED' : 'VACANT',
      },
    })
    if (!spec.occupied) continue
    const lease = await prisma.lease.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01T00:00:00.000Z'),
        rentCents: 120_000,
        rentDueDay: 1,
      },
    })
    await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId } })
    await prisma.leasePayer.create({
      data: {
        leaseId: lease.id,
        propertyId: property.id,
        payerType: 'TENANT',
        tenantId,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      },
    })
  }
  return property.id
}

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `rubs-${Date.now()}`, type: 'LLC' },
  })
  entityId = entity.id
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Sam', lastName: `Meter-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id

  for (const [state, rubsPermitted] of [
    [PERMITTED_STATE, true],
    [FORBIDDEN_STATE, false],
  ] as const) {
    const rule = await prisma.jurisdictionRule.create({
      data: {
        state,
        jurisdiction: null,
        version: 1,
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        graceDays: 3,
        lateFeeType: 'NONE',
        depositEscrowRequired: false,
        depositInterestRequired: false,
        justCauseRequired: false,
        paymentAllocationOrder: ['RENT'],
        rubsPermitted,
      },
    })
    ruleIds.push(rule.id)
  }

  permittedPropertyId = await seedProperty(PERMITTED_STATE, [
    { name: 'A', squareFeet: 1_000, occupied: true },
    { name: 'B', squareFeet: 3_000, occupied: true },
  ])
  forbiddenPropertyId = await seedProperty(FORBIDDEN_STATE, [
    { name: 'A', squareFeet: 1_000, occupied: true },
  ])
})

afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.property.updateMany({
    where: { id: { in: [permittedPropertyId, forbiddenPropertyId] } },
    data: { active: false },
  })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  // The rules can go: nothing append-only references them yet in this file's
  // fixtures, and leaving a `ZZ` state behind would change what every other
  // spec's `rulesFor` resolves.
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: ruleIds } } })
})

async function seedBill(
  propertyId: string,
  over: { amountCents?: number; method?: 'EQUAL' | 'BEDROOMS' | 'SQUARE_FEET' } = {},
) {
  return prisma.utilityBill.create({
    data: {
      propertyId,
      utilityType: 'WATER',
      provider: 'City',
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-07-31T00:00:00.000Z'),
      amountCents: over.amountCents ?? 41_200,
      method: over.method ?? 'SQUARE_FEET',
    },
  })
}

describe('allocateBill', () => {
  it('charges each occupied unit its share, with the arithmetic on the charge', async () => {
    const bill = await seedBill(permittedPropertyId)
    const result = await allocateBill(bill.id)

    expect(result.outcome).toBe('allocated')
    expect(result.chargedCents).toBe(41_200)

    const charges = await prisma.charge.findMany({
      where: { utilityBillId: bill.id },
      orderBy: { amountCents: 'asc' },
    })
    expect(charges.map((charge) => charge.amountCents)).toEqual([10_300, 30_900])
    for (const charge of charges) {
      expect(charge.type).toBe('RUBS_ALLOCATION')
      // PAY-08: the tenant can check it against the bill attached to it.
      expect(charge.description).toContain('sq ft')
      expect(charge.description).toContain('$412.00')
      // D-12: core decided the amount, Stripe was handed a finished number.
      expect(charge.stripeInvoiceItemId).not.toBeNull()
      // Due when the period ended, not when somebody entered the bill - a
      // late entry must not make the charge look late.
      expect(charge.dueOn.toISOString().slice(0, 10)).toBe('2026-07-31')
    }
  }, 20_000)

  it('REFUSES where the state does not permit it', async () => {
    // D-4's whole point. `rubsPermitted` has had a column, a form field and a
    // seed value since R-010 and no reader; this is the reader.
    const bill = await seedBill(forbiddenPropertyId, { method: 'EQUAL' })
    const result = await allocateBill(bill.id)

    expect(result.outcome).toBe('not_permitted')
    expect(result.detail).toContain(FORBIDDEN_STATE)
    expect(await prisma.charge.count({ where: { utilityBillId: bill.id } })).toBe(0)
    // And it is not marked allocated, so fixing the rule and trying again
    // works rather than being permanently refused.
    const after = await prisma.utilityBill.findUniqueOrThrow({ where: { id: bill.id } })
    expect(after.allocatedAt).toBeNull()
  }, 20_000)

  it('splits a bill ONCE however often it is pressed', async () => {
    // A bill allocated twice bills every tenant twice.
    const bill = await seedBill(permittedPropertyId)
    await allocateBill(bill.id)
    const second = await allocateBill(bill.id)

    expect(second.outcome).toBe('already_allocated')
    expect(await prisma.charge.count({ where: { utilityBillId: bill.id } })).toBe(2)
  }, 20_000)

  it('leaves the vacant unit’s share with the owner and records it', async () => {
    const propertyId = await seedProperty(PERMITTED_STATE, [
      { name: 'A', squareFeet: 1_000, occupied: true },
      { name: 'B', squareFeet: 1_000, occupied: false },
    ])
    const bill = await seedBill(propertyId, { amountCents: 40_000, method: 'EQUAL' })
    const result = await allocateBill(bill.id)

    expect(result.outcome).toBe('allocated')
    expect(result.chargedCents).toBe(20_000)
    expect(result.landlordCents).toBe(20_000)

    const after = await prisma.utilityBill.findUniqueOrThrow({ where: { id: bill.id } })
    // Recorded on the bill, because a split adding up to less than the bill
    // is one somebody will be asked to explain.
    expect(after.landlordCents).toBe(20_000)

    await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  }, 20_000)

  it('refuses a split it cannot compute, without charging anybody', async () => {
    const propertyId = await seedProperty(PERMITTED_STATE, [
      { name: 'A', squareFeet: 1_000, occupied: true },
      { name: 'NoFigure', squareFeet: null, occupied: true },
    ])
    const bill = await seedBill(propertyId, { method: 'SQUARE_FEET' })
    const result = await allocateBill(bill.id)

    expect(result.outcome).toBe('refused')
    expect(result.detail).toContain('NoFigure')
    expect(await prisma.charge.count({ where: { utilityBillId: bill.id } })).toBe(0)

    await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  }, 20_000)

  it('writes the whole split to the audit trail, not just the total', async () => {
    // The defence of a RUBS charge is being able to show the arithmetic
    // against the bill it came from. An entry saying "allocated $412" cannot.
    const bill = await seedBill(permittedPropertyId)
    await allocateBill(bill.id)

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'UtilityBill', entityId: bill.id, action: 'billing.rubs_allocated' },
    })
    const after = entry.after as { weights: number[]; shares: { amountCents: number }[] }
    expect(after.weights).toEqual([1_000, 3_000])
    expect(after.shares.map((share) => share.amountCents)).toEqual([10_300, 30_900])
  }, 20_000)
})
