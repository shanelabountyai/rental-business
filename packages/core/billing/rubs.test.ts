import { describe, expect, it } from 'vitest'
import { allocateUtilityBill, describeRubsShare, isRubsMethod } from './rubs.ts'

// Splitting a utility bill across units (PAY-08, R-042).
//
// `allocate()` has its own tests in packages/core/money. What is asserted
// here is what this layer adds: that the vacant unit's share stays with the
// owner, that the parts still sum to the bill when it does, and that a
// missing figure is refused rather than guessed at.

const bill = {
  amountCents: 41_200,
  utilityLabel: 'Water',
  periodStart: '2026-07-01',
  periodEnd: '2026-07-31',
} as const

function unit(name: string, over: Partial<Parameters<typeof allocateUtilityBill>[0]['units'][number]> = {}) {
  return {
    unitId: `u-${name}`,
    unitName: name,
    leaseId: `lease-${name}`,
    bedrooms: 2,
    squareFeet: 1_000,
    ...over,
  }
}

describe('allocateUtilityBill', () => {
  it('splits equally and the parts sum exactly to the bill', () => {
    const result = allocateUtilityBill({
      ...bill,
      amountCents: 10_001,
      method: 'EQUAL',
      units: [unit('A'), unit('B'), unit('C')],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 10001 / 3 does not divide. The remainder cent goes somewhere rather
    // than evaporating, which is `allocate`'s whole job.
    expect(result.shares.map((share) => share.amountCents)).toEqual([3_334, 3_334, 3_333])
    expect(result.shares.reduce((total, share) => total + share.amountCents, 0)).toBe(10_001)
    expect(result.landlordCents).toBe(0)
  })

  it('splits by floor area in proportion', () => {
    const result = allocateUtilityBill({
      ...bill,
      method: 'SQUARE_FEET',
      units: [unit('A', { squareFeet: 1_000 }), unit('B', { squareFeet: 3_000 })],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.shares.map((share) => share.amountCents)).toEqual([10_300, 30_900])
  })

  it('splits by bedrooms', () => {
    const result = allocateUtilityBill({
      ...bill,
      method: 'BEDROOMS',
      units: [unit('A', { bedrooms: 1 }), unit('B', { bedrooms: 3 })],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.shares.map((share) => share.amountCents)).toEqual([10_300, 30_900])
  })

  it('LEAVES THE VACANT UNIT’S SHARE WITH THE OWNER', () => {
    // The abuse this exists to prevent: spreading a vacant unit's share
    // across the tenants makes a tenant's water bill go up because the
    // neighbour moved out, which they can neither predict nor do anything
    // about. Several states' RUBS restrictions are aimed at exactly this.
    const result = allocateUtilityBill({
      ...bill,
      amountCents: 40_000,
      method: 'EQUAL',
      units: [unit('A'), unit('B'), unit('C', { leaseId: null }), unit('D')],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.shares).toHaveLength(3)
    for (const share of result.shares) expect(share.amountCents).toBe(10_000)
    // A quarter of the bill, named rather than silently dropped.
    expect(result.landlordCents).toBe(10_000)
    // And the whole thing still adds up to the bill.
    expect(
      result.shares.reduce((total, share) => total + share.amountCents, 0) +
        result.landlordCents,
    ).toBe(40_000)
  })

  it('does not inflate the tenants’ shares when a unit is empty', () => {
    // The direct comparison: the same three tenants pay the same amount
    // whether or not the fourth unit is occupied.
    const occupied = allocateUtilityBill({
      ...bill,
      amountCents: 40_000,
      method: 'EQUAL',
      units: [unit('A'), unit('B'), unit('C'), unit('D')],
    })
    const vacant = allocateUtilityBill({
      ...bill,
      amountCents: 40_000,
      method: 'EQUAL',
      units: [unit('A'), unit('B'), unit('C'), unit('D', { leaseId: null })],
    })
    expect(occupied.ok && vacant.ok).toBe(true)
    if (!occupied.ok || !vacant.ok) return
    expect(vacant.shares.map((s) => s.amountCents)).toEqual(
      occupied.shares.slice(0, 3).map((s) => s.amountCents),
    )
  })

  it('refuses rather than guessing when a unit has no floor area recorded', () => {
    const result = allocateUtilityBill({
      ...bill,
      method: 'SQUARE_FEET',
      units: [unit('A'), unit('B', { squareFeet: null })],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // Names the unit and the fix. A charge several states regulate is the
    // wrong place to invent an average.
    expect(result.error).toContain('B')
    expect(result.error).toContain('square footage')
  })

  it('refuses a bedroom split when a unit has no bedroom count', () => {
    const result = allocateUtilityBill({
      ...bill,
      method: 'BEDROOMS',
      units: [unit('A'), unit('B', { bedrooms: null })],
    })
    expect(result.ok).toBe(false)
  })

  it('treats a recorded zero as a real weight, not missing data', () => {
    // A studio has no bedrooms. That is a fact, and it means a share of
    // nothing - not a refusal.
    const result = allocateUtilityBill({
      ...bill,
      method: 'BEDROOMS',
      units: [unit('Studio', { bedrooms: 0 }), unit('B', { bedrooms: 2 })],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.shares.map((share) => share.amountCents)).toEqual([0, 41_200])
  })

  it('refuses when every unit weighs zero', () => {
    const result = allocateUtilityBill({
      ...bill,
      method: 'BEDROOMS',
      units: [unit('A', { bedrooms: 0 }), unit('B', { bedrooms: 0 })],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('no ratio')
  })

  it('refuses a bill of nothing, and a property with no units', () => {
    expect(allocateUtilityBill({ ...bill, amountCents: 0, method: 'EQUAL', units: [unit('A')] }).ok).toBe(
      false,
    )
    expect(allocateUtilityBill({ ...bill, method: 'EQUAL', units: [] }).ok).toBe(false)
  })

  it('refuses a period that ends before it starts', () => {
    const result = allocateUtilityBill({
      ...bill,
      periodStart: '2026-07-31',
      periodEnd: '2026-07-01',
      method: 'EQUAL',
      units: [unit('A')],
    })
    expect(result.ok).toBe(false)
  })

  it('puts the arithmetic on every share', () => {
    const result = allocateUtilityBill({
      ...bill,
      method: 'SQUARE_FEET',
      units: [unit('A', { squareFeet: 1_150 }), unit('B', { squareFeet: 3_450 })],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A tenant can check this against the bill attached to it. "Utility
    // allocation $103.00" has to be taken on trust.
    expect(result.shares[0]!.description).toBe(
      'Water 2026-07-01 to 2026-07-31 — $412.00 × 1,150/4,600 sq ft = $103.00',
    )
  })

  it('describes an equal split as a division, not a ratio', () => {
    expect(
      describeRubsShare({
        utilityLabel: 'Trash',
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        billCents: 12_000,
        method: 'EQUAL',
        weight: 1,
        totalWeight: 4,
        amountCents: 3_000,
      }),
    ).toBe('Trash 2026-07-01 to 2026-07-31 — $120.00 ÷ 4 units = $30.00')
  })
})

describe('isRubsMethod', () => {
  it('rejects anything not in the enum', () => {
    expect(isRubsMethod('EQUAL')).toBe(true)
    expect(isRubsMethod('OCCUPANTS')).toBe(false)
  })
})
