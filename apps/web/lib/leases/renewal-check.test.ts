import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { renewalRentCheckFor } from './renewal-check.ts'

// The database half of the renewal rent-increase guard (LEASE-09, R-065),
// against real config - same shape retaliation-check.test.ts already gives
// its own DB-half function.

let entityId: string
let propertyId: string
const ruleIds: string[] = []

beforeAll(async () => {
  const stamp = `renewalcheck-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '9 Renewal Ct',
      city: 'Houston',
      state: 'ZZ', // a state deliberately never configured
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
})

afterAll(async () => {
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: ruleIds } } })
  await prisma.property.delete({ where: { id: propertyId } })
  await prisma.legalEntity.delete({ where: { id: entityId } })
})

afterEach(async () => {
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: ruleIds } } })
  ruleIds.length = 0
})

async function seedRule(overrides: {
  rentIncreaseCapPercentBps?: number | null
  rentIncreaseNoticeDays?: number | null
}) {
  const rule = await prisma.jurisdictionRule.create({
    data: {
      state: 'ZZ',
      version: 1,
      effectiveFrom: new Date('2020-01-01'),
      graceDays: 0,
      lateFeeType: 'NONE',
      rentIncreaseCapPercentBps: overrides.rentIncreaseCapPercentBps,
      rentIncreaseNoticeDays: overrides.rentIncreaseNoticeDays,
      paymentAllocationOrder: [],
    },
  })
  ruleIds.push(rule.id)
  return rule
}

describe('renewalRentCheckFor', () => {
  it('reads the cap and notice period off the real JurisdictionRule row', async () => {
    await seedRule({ rentIncreaseCapPercentBps: 500, rentIncreaseNoticeDays: 30 })

    const decision = await renewalRentCheckFor({
      propertyState: 'ZZ',
      propertyCounty: null,
      currentRentCents: 100_000,
      proposedRentCents: 110_000, // 10%, over the 5% cap
      effectiveOn: new Date('2026-09-01'),
      offeredOn: new Date('2026-08-01'),
    })

    expect(decision.basis).toBe('capped')
    expect(decision.blocked).toBe(true)
  })

  it('fails open (no cap, no notice requirement) when the state has no rule configured at all', async () => {
    const decision = await renewalRentCheckFor({
      propertyState: 'YY', // no rule ever seeded for this one
      propertyCounty: null,
      currentRentCents: 100_000,
      proposedRentCents: 150_000, // a 50% raise with zero notice
      effectiveOn: new Date('2026-08-01'),
      offeredOn: new Date('2026-08-01'),
    })

    expect(decision.basis).toBe('within_limits')
    expect(decision.blocked).toBe(false)
    expect(decision.needsOverride).toBe(false)
  })

  it('a null cap with a configured notice period only checks notice', async () => {
    await seedRule({ rentIncreaseCapPercentBps: null, rentIncreaseNoticeDays: 60 })

    const decision = await renewalRentCheckFor({
      propertyState: 'ZZ',
      propertyCounty: null,
      currentRentCents: 100_000,
      proposedRentCents: 200_000, // 100% raise - would be capped if anything were configured
      effectiveOn: new Date('2026-08-15'), // 14 days out - short of 60
      offeredOn: new Date('2026-08-01'),
    })

    expect(decision.basis).toBe('insufficient_notice')
    expect(decision.blocked).toBe(false)
    expect(decision.needsOverride).toBe(true)
  })
})
