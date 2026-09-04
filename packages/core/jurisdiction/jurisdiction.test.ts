import { describe, expect, it } from 'vitest'
import {
  computeCoverage,
  type JurisdictionRuleInput,
  type JurisdictionRuleLike,
  type RuleCoverageLike,
  selectApplicableRule,
  validateJurisdictionRule,
} from './index.ts'

function baseInput(
  overrides: Partial<JurisdictionRuleInput> = {},
): JurisdictionRuleInput {
  return {
    state: 'TX',
    jurisdiction: null,
    effectiveFrom: new Date('2026-01-01'),
    graceDays: 1,
    lateFeeType: 'PERCENT_OF_RENT',
    lateFeePercentBps: 1000,
    lateFeeMaxPercentBps: 1200,
    depositMaxBps: null,
    depositDispositionDays: 30,
    depositEscrowRequired: false,
    depositInterestRequired: false,
    entryNoticeHours: 24,
    payOrQuitDays: 3,
    noticeToVacateDays: 30,
    rentIncreaseNoticeDays: 30,
    retaliationWindowDays: 180,
    sourceOfIncomeProtected: false,
    justCauseRequired: false,
    paymentAllocationOrder: ['RENT', 'LATE_FEE'],
    nsfFeePermitted: true,
    nsfFeeMaxCents: 3_000,
    cardSurchargePolicy: 'CREDIT_ONLY',
    cardSurchargeMaxBps: null,
    applicationFeeCapCents: null,
    rubsPermitted: true,
    citation: 'Tex. Prop. Code §92.019',
    reviewedBy: null,
    notes: null,
    ...overrides,
  }
}

describe('validateJurisdictionRule', () => {
  it('accepts a complete, consistent rule', () => {
    expect(validateJurisdictionRule(baseInput())).toEqual([])
  })

  it('accepts a rule with every optional field left blank', () => {
    expect(
      validateJurisdictionRule(
        baseInput({
          lateFeeType: 'NONE',
          lateFeePercentBps: null,
          lateFeeMaxPercentBps: null,
          depositDispositionDays: null,
          entryNoticeHours: null,
          payOrQuitDays: null,
          noticeToVacateDays: null,
          rentIncreaseNoticeDays: null,
          retaliationWindowDays: null,
        }),
      ),
    ).toEqual([])
  })

  it('rejects an unrealistic retaliation-window day count', () => {
    expect(
      validateJurisdictionRule(baseInput({ retaliationWindowDays: -1 })),
    ).toContainEqual(expect.objectContaining({ field: 'retaliationWindowDays' }))
    expect(
      validateJurisdictionRule(baseInput({ retaliationWindowDays: 400 })),
    ).toContainEqual(expect.objectContaining({ field: 'retaliationWindowDays' }))
  })

  it('leaves the pre-move-out walkthrough right unreviewed (null) by default, and accepts it granted with a day count', () => {
    expect(validateJurisdictionRule(baseInput())).toEqual([])
    expect(
      validateJurisdictionRule(
        baseInput({ preMoveOutWalkthroughRequired: true, preMoveOutWalkthroughDaysBefore: 14 }),
      ),
    ).toEqual([])
  })

  it('rejects an unrealistic pre-move-out walkthrough day count', () => {
    expect(
      validateJurisdictionRule(baseInput({ preMoveOutWalkthroughDaysBefore: -1 })),
    ).toContainEqual(expect.objectContaining({ field: 'preMoveOutWalkthroughDaysBefore' }))
    expect(
      validateJurisdictionRule(baseInput({ preMoveOutWalkthroughDaysBefore: 200 })),
    ).toContainEqual(expect.objectContaining({ field: 'preMoveOutWalkthroughDaysBefore' }))
  })

  // R-153: the five fields the rule form never rendered, now validated on
  // the same write path as everything else.
  it('rejects an unrealistic violation cure period', () => {
    expect(
      validateJurisdictionRule(baseInput({ leaseViolationCureDays: 400 })),
    ).toContainEqual(expect.objectContaining({ field: 'leaseViolationCureDays' }))
  })

  // R-156: a counsel note with no stance recorded is a half-finished edit -
  // the case page's warning hangs off the stance, so the note would never
  // show anywhere.
  it('rejects an acceptance-waiver note on an unreviewed stance, and accepts it with one', () => {
    expect(
      validateJurisdictionRule(baseInput({ acceptanceWaiverNote: 'Partial acceptance waives.' })),
    ).toContainEqual(expect.objectContaining({ field: 'acceptanceWaiverNote' }))
    expect(
      validateJurisdictionRule(
        baseInput({ acceptanceWaivesNotice: false, acceptanceWaiverNote: 'Partial acceptance waives.' }),
      ),
    ).toEqual([])
    expect(validateJurisdictionRule(baseInput({ acceptanceWaivesNotice: true }))).toEqual([])
  })

  it('rejects an NSF cap on a rule that says the fee is not permitted', () => {
    expect(
      validateJurisdictionRule(baseInput({ nsfFeePermitted: false, nsfFeeMaxCents: 3_000 })),
    ).toContainEqual(expect.objectContaining({ field: 'nsfFeeMaxCents' }))
    expect(
      validateJurisdictionRule(baseInput({ nsfFeePermitted: false, nsfFeeMaxCents: null })),
    ).toEqual([])
  })

  it('rejects an unknown card-surcharge policy', () => {
    expect(
      validateJurisdictionRule(baseInput({ cardSurchargePolicy: 'DEBIT_ONLY' })),
    ).toContainEqual(expect.objectContaining({ field: 'cardSurchargePolicy' }))
  })

  it('rejects a surcharge cap on a rule whose policy is NONE', () => {
    expect(
      validateJurisdictionRule(
        baseInput({ cardSurchargePolicy: 'NONE', cardSurchargeMaxBps: 300 }),
      ),
    ).toContainEqual(expect.objectContaining({ field: 'cardSurchargeMaxBps' }))
    expect(
      validateJurisdictionRule(
        baseInput({ cardSurchargePolicy: 'ALL', cardSurchargeMaxBps: 300 }),
      ),
    ).toEqual([])
  })

  it('rejects a state that is not a real US state code', () => {
    const violations = validateJurisdictionRule(baseInput({ state: 'ZZ' }))
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'state' }),
    )
  })

  it('rejects a whitespace-only jurisdiction instead of leaving it null', () => {
    const violations = validateJurisdictionRule(
      baseInput({ jurisdiction: '   ' }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'jurisdiction' }),
    )
  })

  it('rejects an invalid effective date', () => {
    const violations = validateJurisdictionRule(
      baseInput({ effectiveFrom: new Date('not a date') }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'effectiveFrom' }),
    )
  })

  it('rejects an unknown late-fee type', () => {
    const violations = validateJurisdictionRule(
      baseInput({ lateFeeType: 'SOMETHING_ELSE' }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'lateFeeType' }),
    )
  })

  it('requires a flat amount when the type is FLAT', () => {
    const violations = validateJurisdictionRule(
      baseInput({
        lateFeeType: 'FLAT',
        lateFeePercentBps: null,
        lateFeeMaxPercentBps: null,
        lateFeeFlatCents: null,
      }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'lateFeeFlatCents' }),
    )
  })

  it('requires both a flat and a daily amount for FLAT_PLUS_DAILY', () => {
    const violations = validateJurisdictionRule(
      baseInput({
        lateFeeType: 'FLAT_PLUS_DAILY',
        lateFeePercentBps: null,
        lateFeeMaxPercentBps: null,
        lateFeeFlatCents: null,
        lateFeeDailyCents: null,
      }),
    )
    const fields = violations.map((v) => v.field)
    expect(fields).toContain('lateFeeFlatCents')
    expect(fields).toContain('lateFeeDailyCents')
  })

  it('rejects a fee amount left on a NONE-type rule', () => {
    const violations = validateJurisdictionRule(
      baseInput({
        lateFeeType: 'NONE',
        lateFeeFlatCents: 5000,
      }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'lateFeeType' }),
    )
  })

  it('rejects a percent-of-rent fee above 100%', () => {
    const violations = validateJurisdictionRule(
      baseInput({ lateFeePercentBps: 10_001 }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'lateFeePercentBps' }),
    )
  })

  it('rejects a negative deposit disposition window', () => {
    const violations = validateJurisdictionRule(
      baseInput({ depositDispositionDays: -1 }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'depositDispositionDays' }),
    )
  })

  it('rejects NaN slipped past a browser-bypassing caller', () => {
    const violations = validateJurisdictionRule(
      baseInput({ entryNoticeHours: Number.NaN }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'entryNoticeHours' }),
    )
  })

  it('requires at least one entry in the payment allocation order', () => {
    const violations = validateJurisdictionRule(
      baseInput({ paymentAllocationOrder: [] }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'paymentAllocationOrder' }),
    )
  })

  it('rejects a payment allocation order with a charge type that does not exist', () => {
    const violations = validateJurisdictionRule(
      baseInput({ paymentAllocationOrder: ['RENT', 'MADE_UP_TYPE'] }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'paymentAllocationOrder' }),
    )
  })

  it('rejects a charge type repeated in the payment allocation order', () => {
    const violations = validateJurisdictionRule(
      baseInput({ paymentAllocationOrder: ['RENT', 'RENT'] }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'paymentAllocationOrder' }),
    )
  })

  it('accumulates every violation rather than stopping at the first', () => {
    const violations = validateJurisdictionRule(
      baseInput({
        state: 'ZZ',
        graceDays: -1,
        paymentAllocationOrder: [],
      }),
    )
    const fields = violations.map((v) => v.field)
    expect(fields).toContain('state')
    expect(fields).toContain('graceDays')
    expect(fields).toContain('paymentAllocationOrder')
  })
})

describe('selectApplicableRule', () => {
  const statewideV1: JurisdictionRuleLike & { label: string } = {
    label: 'statewide v1',
    jurisdiction: null,
    effectiveFrom: new Date('2025-01-01'),
    effectiveTo: new Date('2025-12-31'),
  }
  const statewideV2: JurisdictionRuleLike & { label: string } = {
    label: 'statewide v2',
    jurisdiction: null,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
  }
  const countyRule: JurisdictionRuleLike & { label: string } = {
    label: 'county',
    jurisdiction: 'Harris',
    effectiveFrom: new Date('2026-03-01'),
    effectiveTo: null,
  }
  const candidates = [statewideV1, statewideV2, countyRule]

  it('picks the statewide rule in force on the given day', () => {
    const result = selectApplicableRule(candidates, null, new Date('2025-06-01'))
    expect(result?.label).toBe('statewide v1')
  })

  it('picks the newer statewide version once it takes effect', () => {
    const result = selectApplicableRule(candidates, null, new Date('2026-02-01'))
    expect(result?.label).toBe('statewide v2')
  })

  it('prefers a local ordinance over the statewide rule once it is in force', () => {
    const result = selectApplicableRule(
      candidates,
      'Harris',
      new Date('2026-04-01'),
    )
    expect(result?.label).toBe('county')
  })

  it('falls back to statewide when the local ordinance has not taken effect yet', () => {
    const result = selectApplicableRule(
      candidates,
      'Harris',
      new Date('2026-02-01'),
    )
    expect(result?.label).toBe('statewide v2')
  })

  it('matches jurisdiction case- and whitespace-insensitively', () => {
    const result = selectApplicableRule(
      candidates,
      '  harris  ',
      new Date('2026-04-01'),
    )
    expect(result?.label).toBe('county')
  })

  it('falls back to statewide for a county with no ordinance at all', () => {
    const result = selectApplicableRule(
      candidates,
      'Travis',
      new Date('2026-04-01'),
    )
    expect(result?.label).toBe('statewide v2')
  })

  it('returns null when nothing is effective yet', () => {
    const result = selectApplicableRule(candidates, null, new Date('2024-01-01'))
    expect(result).toBeNull()
  })

  it('returns null for a state with no candidates at all', () => {
    expect(selectApplicableRule([], null, new Date('2026-01-01'))).toBeNull()
  })
})

// R-162: portfolio-wide predicates ("which state has no rule, which rule has
// an unreviewed field") cannot be exercised end-to-end against the shared
// e2e database - it holds real rules for every real state, so no state code
// is safe to assert "has no rule" against there (D-4, the same posture
// R-138's revokeRefusal takes for a deployment-wide predicate). Covered here
// as a unit test that takes the list as a value instead.
describe('computeCoverage', () => {
  function rule(overrides: Partial<RuleCoverageLike> = {}): RuleCoverageLike {
    return {
      state: 'TX',
      jurisdiction: null,
      reviewedBy: 'Counsel Q. Test',
      retaliationWindowDays: 180,
      sourceOfIncomeProtected: false,
      preMoveOutWalkthroughRequired: true,
      earlyTerminationRightExists: true,
      acceptanceWaivesNotice: false,
      ...overrides,
    }
  }

  it('names a property state with no rule at all', () => {
    const { statesNeedingRule } = computeCoverage(['TX', 'FL'], [rule({ state: 'TX' })])
    expect(statesNeedingRule).toEqual(['FL'])
  })

  it('is silent about a fully reviewed rule', () => {
    const { statesNeedingRule, gaps } = computeCoverage(['TX'], [rule()])
    expect(statesNeedingRule).toEqual([])
    expect(gaps).toEqual([])
  })

  it('flags an unreviewed row even when every field is filled in', () => {
    const { gaps } = computeCoverage(['TX'], [rule({ reviewedBy: null })])
    expect(gaps).toEqual([
      {
        state: 'TX',
        jurisdiction: null,
        unreviewedFields: ['not yet reviewed by an attorney'],
      },
    ])
  })

  it("lists R-055's retaliation window alongside the other unreviewed legal fields", () => {
    const { gaps } = computeCoverage(
      ['TX'],
      [rule({ retaliationWindowDays: null, earlyTerminationRightExists: null })],
    )
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.unreviewedFields).toEqual([
      'retaliation window (RISK-06)',
      'early-termination right (RISK-04)',
    ])
  })

  it('a state with no property at all is never listed as needing a rule', () => {
    const { statesNeedingRule } = computeCoverage([], [])
    expect(statesNeedingRule).toEqual([])
  })
})
