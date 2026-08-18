import { describe, expect, it } from 'vitest'
import {
  isIncomeRange,
  validatePrescreenAnswers,
  validateProspectInquiry,
} from './index.ts'

describe('validateProspectInquiry', () => {
  function base(overrides: Partial<Parameters<typeof validateProspectInquiry>[0]> = {}) {
    return {
      listingId: 'listing_1',
      firstName: 'Priya',
      lastName: 'Patel',
      email: 'priya@example.test',
      phone: null,
      message: null,
      ...overrides,
    }
  }

  it('accepts a complete inquiry', () => {
    expect(validateProspectInquiry(base())).toEqual([])
  })

  it('accepts phone-only contact, no email at all', () => {
    expect(validateProspectInquiry(base({ email: null, phone: '+15125550100' }))).toEqual([])
  })

  it('rejects neither email nor phone', () => {
    expect(validateProspectInquiry(base({ email: null, phone: null }))).toContainEqual(
      expect.objectContaining({ field: 'email' }),
    )
  })

  it('rejects a missing name', () => {
    expect(validateProspectInquiry(base({ firstName: '' }))).toContainEqual(
      expect.objectContaining({ field: 'firstName' }),
    )
    expect(validateProspectInquiry(base({ lastName: '' }))).toContainEqual(
      expect.objectContaining({ field: 'lastName' }),
    )
  })

  it('rejects a missing listing', () => {
    expect(validateProspectInquiry(base({ listingId: '' }))).toContainEqual(
      expect.objectContaining({ field: 'listingId' }),
    )
  })
})

describe('isIncomeRange', () => {
  it('recognises a real bucket and rejects an invented one', () => {
    expect(isIncomeRange('UNDER_3000')).toBe(true)
    expect(isIncomeRange('A_MILLION_DOLLARS')).toBe(false)
  })
})

describe('validatePrescreenAnswers', () => {
  function base(overrides: Partial<Parameters<typeof validatePrescreenAnswers>[0]> = {}) {
    return {
      moveDate: new Date('2026-09-01'),
      occupants: 2,
      petsDescription: null,
      incomeRange: 'RANGE_3000_5000',
      priorEvictions: false,
      priorEvictionsDetail: null,
      ...overrides,
    }
  }

  it('accepts a complete set of answers', () => {
    expect(validatePrescreenAnswers(base())).toEqual([])
  })

  it('rejects a missing or unparseable move date', () => {
    expect(validatePrescreenAnswers(base({ moveDate: null }))).toContainEqual(
      expect.objectContaining({ field: 'moveDate' }),
    )
  })

  it('rejects an unrealistic occupant count', () => {
    expect(validatePrescreenAnswers(base({ occupants: 0 }))).toContainEqual(
      expect.objectContaining({ field: 'occupants' }),
    )
    expect(validatePrescreenAnswers(base({ occupants: 21 }))).toContainEqual(
      expect.objectContaining({ field: 'occupants' }),
    )
    expect(validatePrescreenAnswers(base({ occupants: null }))).toContainEqual(
      expect.objectContaining({ field: 'occupants' }),
    )
  })

  it('rejects a missing or invalid income range', () => {
    expect(validatePrescreenAnswers(base({ incomeRange: null }))).toContainEqual(
      expect.objectContaining({ field: 'incomeRange' }),
    )
    expect(validatePrescreenAnswers(base({ incomeRange: 'A_LOT' }))).toContainEqual(
      expect.objectContaining({ field: 'incomeRange' }),
    )
  })

  it('requires prior evictions to be explicitly answered, not merely left falsy', () => {
    expect(validatePrescreenAnswers(base({ priorEvictions: null }))).toContainEqual(
      expect.objectContaining({ field: 'priorEvictions' }),
    )
    // false is a real, complete answer - not a violation.
    expect(validatePrescreenAnswers(base({ priorEvictions: false }))).toEqual([])
  })

  it('requires detail when the answer is yes, but not when it is no', () => {
    expect(
      validatePrescreenAnswers(base({ priorEvictions: true, priorEvictionsDetail: null })),
    ).toContainEqual(expect.objectContaining({ field: 'priorEvictionsDetail' }))
    expect(
      validatePrescreenAnswers(
        base({ priorEvictions: true, priorEvictionsDetail: 'Medical bills, 2019.' }),
      ),
    ).toEqual([])
  })
})
