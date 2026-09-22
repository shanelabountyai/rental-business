import { describe, expect, it } from 'vitest'
import { validateCriteriaInput } from './criteria.ts'

const VALID = {
  incomeToRentMultiplierX100: 300,
  minCreditScore: 600,
  evictionLookbackMonths: 84,
  criminalLookbackMonths: 84,
  citation: null,
  reviewedBy: 'Jane Attorney',
  notes: null,
}

describe('validateCriteriaInput', () => {
  it('accepts a fully reviewed version', () => {
    expect(validateCriteriaInput(VALID)).toEqual([])
  })

  it('accepts a null credit floor', () => {
    expect(validateCriteriaInput({ ...VALID, minCreditScore: null })).toEqual([])
  })

  it('refuses a version with no reviewer (OQ-6)', () => {
    const violations = validateCriteriaInput({ ...VALID, reviewedBy: null })
    expect(violations.map((v) => v.field)).toContain('reviewedBy')
  })

  it('refuses a non-positive income multiplier', () => {
    const violations = validateCriteriaInput({ ...VALID, incomeToRentMultiplierX100: 0 })
    expect(violations.map((v) => v.field)).toContain('incomeToRentMultiplierX100')
  })

  it('refuses a credit floor outside 300-850', () => {
    expect(
      validateCriteriaInput({ ...VALID, minCreditScore: 200 }).map((v) => v.field),
    ).toContain('minCreditScore')
    expect(
      validateCriteriaInput({ ...VALID, minCreditScore: 900 }).map((v) => v.field),
    ).toContain('minCreditScore')
  })

  it('refuses a negative or fractional lookback', () => {
    expect(
      validateCriteriaInput({ ...VALID, evictionLookbackMonths: -1 }).map((v) => v.field),
    ).toContain('evictionLookbackMonths')
    expect(
      validateCriteriaInput({ ...VALID, criminalLookbackMonths: 1.5 }).map((v) => v.field),
    ).toContain('criminalLookbackMonths')
  })
})
