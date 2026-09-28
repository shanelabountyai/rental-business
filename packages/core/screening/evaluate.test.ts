import { describe, expect, it } from 'vitest'
import { evaluateCriteria, type ScreeningCriteriaConfig } from './evaluate.ts'

const criteria: ScreeningCriteriaConfig = {
  version: 1,
  incomeToRentMultiplierX100: 300,
  minCreditScore: 600,
  evictionLookbackMonths: 84,
  criminalLookbackMonths: 84,
}

const undated = { evictionRecordOn: null, criminalRecordOn: null, asOf: '2026-09-28' }

describe('evaluateCriteria', () => {
  it('meets every criterion with clean facts', () => {
    const results = evaluateCriteria(criteria, {
      monthlyIncomeCents: 600_000,
      rentCents: 150_000,
      creditScore: 700,
      evictionRecordFound: false,
      criminalRecordFound: false,
      ...undated,
    })
    expect(results.every((r) => r.result === 'MEETS')).toBe(true)
  })

  it('fails income just under the multiplier, meets right at it', () => {
    const under = evaluateCriteria(criteria, {
      monthlyIncomeCents: 449_999,
      rentCents: 150_000,
      creditScore: null,
      evictionRecordFound: null,
      criminalRecordFound: null,
      ...undated,
    }).find((r) => r.key === 'income')
    expect(under?.result).toBe('FAILS')

    const at = evaluateCriteria(criteria, {
      monthlyIncomeCents: 450_000,
      rentCents: 150_000,
      creditScore: null,
      evictionRecordFound: null,
      criminalRecordFound: null,
      ...undated,
    }).find((r) => r.key === 'income')
    expect(at?.result).toBe('MEETS')
  })

  it('reports UNKNOWN, never FAILS, for a fact not yet reported', () => {
    const results = evaluateCriteria(criteria, {
      monthlyIncomeCents: null,
      rentCents: 150_000,
      creditScore: null,
      evictionRecordFound: null,
      criminalRecordFound: null,
      ...undated,
    })
    expect(results.every((r) => r.result === 'UNKNOWN')).toBe(true)
  })

  it('a found eviction or criminal record FAILS its own criterion without touching the others', () => {
    const results = evaluateCriteria(criteria, {
      monthlyIncomeCents: 600_000,
      rentCents: 150_000,
      creditScore: 700,
      evictionRecordFound: true,
      criminalRecordFound: false,
      ...undated,
      evictionRecordOn: '2024-03-01',
    })
    expect(results.find((r) => r.key === 'eviction')?.result).toBe('FAILS')
    expect(results.find((r) => r.key === 'criminal')?.result).toBe('MEETS')
    expect(results.find((r) => r.key === 'income')?.result).toBe('MEETS')
  })

  it('a null credit floor is UNKNOWN, not a silent pass', () => {
    const result = evaluateCriteria(
      { ...criteria, minCreditScore: null },
      {
        monthlyIncomeCents: 600_000,
        rentCents: 150_000,
        creditScore: 700,
        evictionRecordFound: false,
        criminalRecordFound: false,
        ...undated,
      },
    ).find((r) => r.key === 'credit')
    expect(result?.result).toBe('UNKNOWN')
  })

  describe('lookback window (LEGAL-01)', () => {
    const withEviction = (evictionRecordOn: string | null) =>
      evaluateCriteria(criteria, {
        monthlyIncomeCents: 600_000,
        rentCents: 150_000,
        creditScore: 700,
        evictionRecordFound: true,
        criminalRecordFound: false,
        ...undated,
        evictionRecordOn,
      }).find((r) => r.key === 'eviction')!

    it('a 12-year-old record is NOT cited as within an 84-month lookback', () => {
      const result = withEviction('2014-06-15')
      expect(result.result).toBe('MEETS')
      expect(result.detail).not.toContain('within')
      expect(result.detail).toContain('outside the 84-month lookback')
    })

    it('the boundary: exactly 84 months back is inside, one day earlier is outside', () => {
      expect(withEviction('2019-09-28').result).toBe('FAILS')
      expect(withEviction('2019-09-27').result).toBe('MEETS')
    })

    it('cites the record date when it is within the window', () => {
      expect(withEviction('2024-03-01').detail).toBe(
        'A record dated 1 Mar 2024 was found within the 84-month lookback - requires individualized assessment.',
      )
    })

    it('an undated record is UNKNOWN - never claimed inside the window', () => {
      const result = withEviction(null)
      expect(result.result).toBe('UNKNOWN')
      expect(result.detail).not.toMatch(/found within/)
    })
  })
})
