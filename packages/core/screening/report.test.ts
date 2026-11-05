import { describe, expect, it } from 'vitest'
import { criterionInForce, type ScreeningCriteriaConfig } from './evaluate.ts'
import { type DecisionRow, decisionReport, parseQuarter, quarterOf } from './report.ts'

describe('criterionInForce (R-297)', () => {
  const v: ScreeningCriteriaConfig = {
    version: 1,
    incomeToRentMultiplierX100: 300,
    minCreditScore: null,
    evictionLookbackMonths: 84,
    criminalLookbackMonths: 0,
  }

  it('is false for a credit reason under a version with no floor, and a zero-month lookback', () => {
    expect(criterionInForce(v, 'income')).toBe(true)
    expect(criterionInForce(v, 'credit')).toBe(false)
    expect(criterionInForce(v, 'eviction')).toBe(true)
    expect(criterionInForce(v, 'criminal')).toBe(false)
    expect(criterionInForce({ ...v, minCreditScore: 600 }, 'credit')).toBe(true)
  })
})

describe('parseQuarter', () => {
  it('bounds a quarter, Q4 rolling into the next year', () => {
    expect(parseQuarter('2026-Q1')).toEqual({ label: '2026-Q1', from: '2026-01-01', to: '2026-04-01' })
    expect(parseQuarter('2026-Q4')).toEqual({ label: '2026-Q4', from: '2026-10-01', to: '2027-01-01' })
  })

  it('refuses anything else', () => {
    for (const bad of ['2026-Q5', '2026-Q0', '2026Q1', '', '2026-Q1; drop']) expect(parseQuarter(bad)).toBeNull()
  })

  it('quarterOf names the quarter a day falls in', () => {
    expect(quarterOf('2026-03-31')).toBe('2026-Q1')
    expect(quarterOf('2026-04-01')).toBe('2026-Q2')
    expect(quarterOf('2026-12-31')).toBe('2026-Q4')
  })
})

describe('decisionReport', () => {
  const row = (over: Partial<DecisionRow>): DecisionRow => ({
    decision: 'APPROVED',
    reasonCode: null,
    reasonLabel: null,
    propertyName: 'Elm',
    completedOn: '2026-10-01',
    decidedOn: '2026-10-03',
    ...over,
  })

  it('counts by outcome, reason and property, and measures days to decision', () => {
    const report = decisionReport([
      row({}),
      row({ decision: 'DECLINED', reasonCode: 'INCOME', reasonLabel: 'Income', decidedOn: '2026-10-11' }),
      row({ decision: 'DECLINED', reasonCode: 'INCOME', reasonLabel: 'Income', propertyName: 'Ash', decidedOn: '2026-10-05' }),
      row({ decision: 'APPROVED_WITH_CONDITIONS', reasonCode: 'CREDIT', reasonLabel: 'Credit', propertyName: 'Ash', completedOn: null }),
    ])
    expect(report.total).toBe(4)
    expect(report.byOutcome).toEqual({ APPROVED: 1, APPROVED_WITH_CONDITIONS: 1, DECLINED: 2 })
    expect(report.byReason).toEqual([
      { code: 'INCOME', label: 'Income', count: 2 },
      { code: 'CREDIT', label: 'Credit', count: 1 },
    ])
    expect(report.byProperty.map((p) => [p.propertyName, p.total, p.byOutcome.DECLINED])).toEqual([
      ['Ash', 2, 1],
      ['Elm', 2, 1],
    ])
    // 2, 4 and 10 days; the row with no completed date is left out.
    expect(report.medianDaysToDecision).toBe(4)
    expect(report.maxDaysToDecision).toBe(10)
  })

  it('reports no time to decision rather than zero for an empty quarter', () => {
    const report = decisionReport([])
    expect(report.total).toBe(0)
    expect(report.medianDaysToDecision).toBeNull()
    expect(report.maxDaysToDecision).toBeNull()
  })
})
