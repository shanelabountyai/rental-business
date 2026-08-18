import { describe, expect, it } from 'vitest'
import { evaluateCriteria, type ScreeningCriteriaConfig } from './evaluate.ts'

const criteria: ScreeningCriteriaConfig = {
  version: 1,
  incomeToRentMultiplierX100: 300,
  minCreditScore: 600,
  evictionLookbackMonths: 84,
  criminalLookbackMonths: 84,
}

describe('evaluateCriteria', () => {
  it('meets every criterion with clean facts', () => {
    const results = evaluateCriteria(criteria, {
      monthlyIncomeCents: 600_000,
      rentCents: 150_000,
      creditScore: 700,
      evictionRecordFound: false,
      criminalRecordFound: false,
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
    }).find((r) => r.key === 'income')
    expect(under?.result).toBe('FAILS')

    const at = evaluateCriteria(criteria, {
      monthlyIncomeCents: 450_000,
      rentCents: 150_000,
      creditScore: null,
      evictionRecordFound: null,
      criminalRecordFound: null,
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
      },
    ).find((r) => r.key === 'credit')
    expect(result?.result).toBe('UNKNOWN')
  })
})
