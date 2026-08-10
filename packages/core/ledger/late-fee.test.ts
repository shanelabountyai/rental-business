import { describe, expect, it } from 'vitest'
import { type LateFeeRule, lateFeeFor, statutoryCeiling } from './index.ts'

// The single most legally-sensitive calculation in the product (PAY-04,
// D-4, D-12). Every number below comes from a rule object; there is not one
// statutory literal in the implementation, and these tests are what proves
// it - each one states a jurisdiction and checks the arithmetic that
// jurisdiction produces.

const RENT = 150_000 // $1,500

/// Texas-shaped: a flat fee, capped. Numbers are illustrative, not legal
/// advice - the real ones live in JurisdictionRule with a citation and a
/// reviewer, per D-4.
function rule(over: Partial<LateFeeRule> = {}): LateFeeRule {
  return {
    graceDays: 2,
    lateFeeType: 'FLAT',
    lateFeeFlatCents: 5_000,
    lateFeePercentBps: null,
    lateFeeDailyCents: null,
    lateFeeMaxCents: null,
    lateFeeMaxPercentBps: null,
    ...over,
  }
}

function facts(over: Partial<Parameters<typeof lateFeeFor>[1]> = {}) {
  return {
    outstandingCents: RENT,
    monthlyRentCents: RENT,
    dueOn: '2026-08-01',
    asOf: '2026-08-10',
    ...over,
  }
}

describe('grace period', () => {
  it('charges NOTHING on the due date', () => {
    const decision = lateFeeFor(rule(), facts({ asOf: '2026-08-01' }))
    expect(decision.basis).toBe('within_grace')
    expect(decision.amountCents).toBe(0)
  })

  it('charges nothing on the LAST day of grace', () => {
    // A 2-day grace means a fee on day 3, not day 2. The tenant is entitled
    // to the whole grace period, and an off-by-one here charges a fee a day
    // early on every lease in the state.
    const decision = lateFeeFor(rule({ graceDays: 2 }), facts({ asOf: '2026-08-03' }))
    expect(decision.daysLate).toBe(2)
    expect(decision.basis).toBe('within_grace')
  })

  it('charges on the day AFTER grace runs out', () => {
    const decision = lateFeeFor(rule({ graceDays: 2 }), facts({ asOf: '2026-08-04' }))
    expect(decision.daysLate).toBe(3)
    expect(decision.basis).toBe('assessed')
    expect(decision.amountCents).toBe(5_000)
  })

  it('honours a zero-day grace', () => {
    // Zero is a real configuration, not "unset" - a fee applies from day one
    // late.
    expect(lateFeeFor(rule({ graceDays: 0 }), facts({ asOf: '2026-08-01' })).basis).toBe(
      'within_grace',
    )
    expect(lateFeeFor(rule({ graceDays: 0 }), facts({ asOf: '2026-08-02' })).basis).toBe(
      'assessed',
    )
  })
})

describe('a jurisdiction with no late fee', () => {
  it('charges nothing however late the rent is', () => {
    const decision = lateFeeFor(
      rule({ lateFeeType: 'NONE' }),
      facts({ asOf: '2027-01-01' }),
    )
    expect(decision.basis).toBe('no_fee_in_jurisdiction')
    expect(decision.amountCents).toBe(0)
  })

  it('does not throw - a NONE rule is a complete answer, not a gap', () => {
    // Refusing to compute would be indistinguishable from a bug at the call
    // site, and the caller would invent a fallback - which is how a
    // hardcoded number gets back in.
    expect(() => lateFeeFor(rule({ lateFeeType: 'NONE' }), facts())).not.toThrow()
  })
})

describe('fee types', () => {
  it('FLAT charges the flat amount regardless of how late', () => {
    const early = lateFeeFor(rule(), facts({ asOf: '2026-08-04' }))
    const late = lateFeeFor(rule(), facts({ asOf: '2026-09-04' }))
    expect(early.amountCents).toBe(5_000)
    expect(late.amountCents).toBe(5_000)
  })

  it('PERCENT_OF_RENT charges on what is OUTSTANDING, not the full rent', () => {
    // A tenant who paid most of the rent must not be charged a percentage of
    // the whole - that is charging on money already received.
    const decision = lateFeeFor(
      rule({ lateFeeType: 'PERCENT_OF_RENT', lateFeePercentBps: 500 }),
      facts({ outstandingCents: 20_000, monthlyRentCents: RENT }),
    )
    expect(decision.amountCents).toBe(1_000) // 5% of $200, not of $1,500
  })

  it('DAILY charges only for days BEYOND grace', () => {
    // 9 days late with a 2-day grace is 7 chargeable days, not 9.
    const decision = lateFeeFor(
      rule({ lateFeeType: 'DAILY', lateFeeDailyCents: 500, graceDays: 2 }),
      facts({ asOf: '2026-08-10' }),
    )
    expect(decision.daysLate).toBe(9)
    expect(decision.amountCents).toBe(3_500) // 7 × $5
  })

  it('FLAT_PLUS_DAILY adds both', () => {
    const decision = lateFeeFor(
      rule({
        lateFeeType: 'FLAT_PLUS_DAILY',
        lateFeeFlatCents: 2_500,
        lateFeeDailyCents: 500,
        graceDays: 2,
      }),
      facts({ asOf: '2026-08-10' }),
    )
    expect(decision.amountCents).toBe(2_500 + 3_500)
  })

  it('refuses to invent a number for an unrecognised type', () => {
    // A configuration error must not become a fee somebody has to explain.
    const decision = lateFeeFor(rule({ lateFeeType: 'SOMETHING_NEW' }), facts())
    expect(decision.amountCents).toBe(0)
    expect(decision.ruleSummary).toMatch(/Unrecognised/)
  })
})

describe('the statutory ceiling — D-12’s whole point', () => {
  it('clamps a computed fee to a flat cap and SAYS it clamped', () => {
    // "We computed $95 and charged $50 because the state caps it" is the
    // sentence that defends the charge. A bare $50 does not.
    const decision = lateFeeFor(
      rule({ lateFeeFlatCents: 9_500, lateFeeMaxCents: 5_000 }),
      facts(),
    )
    expect(decision.computedCents).toBe(9_500)
    expect(decision.amountCents).toBe(5_000)
    expect(decision.cappedAtCents).toBe(5_000)
  })

  it('clamps to a PERCENTAGE-of-rent cap', () => {
    // 12% of $1,500 = $180.
    const decision = lateFeeFor(
      rule({ lateFeeFlatCents: 25_000, lateFeeMaxPercentBps: 1_200 }),
      facts(),
    )
    expect(decision.amountCents).toBe(18_000)
  })

  it('takes the LOWER when both caps apply', () => {
    // The most important assertion here. Reading whichever is non-null
    // first, or taking the higher, charges above a limit somebody wrote into
    // a statute.
    const decision = lateFeeFor(
      rule({
        lateFeeFlatCents: 25_000,
        lateFeeMaxCents: 10_000,
        lateFeeMaxPercentBps: 1_200, // $180
      }),
      facts(),
    )
    expect(decision.amountCents).toBe(10_000)
    expect(statutoryCeiling(
      { lateFeeMaxCents: 10_000, lateFeeMaxPercentBps: 1_200 },
      RENT,
    )).toBe(10_000)
  })

  it('does NOT clamp when the jurisdiction sets no maximum', () => {
    // Null is not zero. Conflating them is how a state with no cap silently
    // stops charging late fees.
    const decision = lateFeeFor(rule({ lateFeeFlatCents: 95_000 }), facts())
    expect(decision.amountCents).toBe(95_000)
    expect(decision.cappedAtCents).toBeNull()
    expect(statutoryCeiling({ lateFeeMaxCents: null, lateFeeMaxPercentBps: null }, RENT))
      .toBeNull()
  })

  it('treats a cap of ZERO as a real cap of zero', () => {
    const decision = lateFeeFor(rule({ lateFeeMaxCents: 0 }), facts())
    expect(decision.amountCents).toBe(0)
    expect(decision.cappedAtCents).toBe(0)
  })

  it('reports no cap when the computed fee is already under it', () => {
    const decision = lateFeeFor(
      rule({ lateFeeFlatCents: 2_000, lateFeeMaxCents: 5_000 }),
      facts(),
    )
    expect(decision.amountCents).toBe(2_000)
    expect(decision.cappedAtCents).toBeNull()
  })
})

describe('nothing outstanding', () => {
  it('charges no fee on a charge that has been paid', () => {
    const decision = lateFeeFor(rule(), facts({ outstandingCents: 0 }))
    expect(decision.basis).toBe('nothing_owed')
    expect(decision.amountCents).toBe(0)
  })

  it('charges no fee on a credit balance', () => {
    expect(lateFeeFor(rule(), facts({ outstandingCents: -5_000 })).basis).toBe(
      'nothing_owed',
    )
  })
})

describe('rounding', () => {
  it('rounds a percentage rather than truncating it', () => {
    // Truncating systematically favours the landlord by up to a cent on
    // every single fee, which is both wrong and looks deliberate in a
    // waiver-pattern report.
    const decision = lateFeeFor(
      rule({ lateFeeType: 'PERCENT_OF_RENT', lateFeePercentBps: 333 }),
      facts({ outstandingCents: 10_005 }),
    )
    // 10005 * 333 / 10000 = 333.1665 -> 333
    expect(decision.amountCents).toBe(333)
  })

  it('always produces whole cents', () => {
    for (const bps of [1, 7, 333, 1_234]) {
      const decision = lateFeeFor(
        rule({ lateFeeType: 'PERCENT_OF_RENT', lateFeePercentBps: bps }),
        facts({ outstandingCents: 123_457 }),
      )
      expect(Number.isInteger(decision.amountCents), `bps ${bps}`).toBe(true)
    }
  })
})
