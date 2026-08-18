import { describe, expect, it } from 'vitest'
import {
  applicationFeeCentsFor,
  isAdult,
  validateApplicantForm,
  validateCoApplicantInvite,
} from './validate.ts'

describe('validateCoApplicantInvite', () => {
  const valid = { firstName: 'Sam', lastName: 'Rivera', email: 'sam@example.test' }

  it('accepts a complete invite', () => {
    expect(validateCoApplicantInvite(valid)).toEqual([])
  })

  it('requires a first name', () => {
    const violations = validateCoApplicantInvite({ ...valid, firstName: '  ' })
    expect(violations.map((v) => v.field)).toEqual(['firstName'])
  })

  it('requires a last name', () => {
    const violations = validateCoApplicantInvite({ ...valid, lastName: '' })
    expect(violations.map((v) => v.field)).toEqual(['lastName'])
  })

  it('requires an email or a phone', () => {
    const violations = validateCoApplicantInvite({ ...valid, email: null })
    expect(violations.map((v) => v.field)).toEqual(['email'])
  })

  it('accepts a phone with no email', () => {
    const violations = validateCoApplicantInvite({ ...valid, email: null, phone: '555-1234' })
    expect(violations).toEqual([])
  })
})

describe('isAdult', () => {
  it('is true the day after the 18th birthday', () => {
    expect(isAdult(new Date('2008-08-17T00:00:00Z'), new Date('2026-08-18T00:00:00Z'))).toBe(true)
  })

  it('is true exactly on the 18th birthday', () => {
    expect(isAdult(new Date('2008-08-18T00:00:00Z'), new Date('2026-08-18T00:00:00Z'))).toBe(true)
  })

  it('is false the day before the 18th birthday', () => {
    expect(isAdult(new Date('2008-08-19T00:00:00Z'), new Date('2026-08-18T00:00:00Z'))).toBe(false)
  })

  it('is false for a 17-year-old', () => {
    expect(isAdult(new Date('2009-01-01T00:00:00Z'), new Date('2026-08-18T00:00:00Z'))).toBe(false)
  })
})

describe('validateApplicantForm', () => {
  const now = new Date('2026-08-18T00:00:00Z')
  const valid = {
    firstName: 'Jordan',
    lastName: 'Blake',
    email: 'jordan@example.test',
    dateOfBirth: new Date('1990-01-01T00:00:00Z'),
    currentAddressLine1: '12 Main St',
    currentCity: 'Houston',
    currentState: 'TX',
    currentPostalCode: '77002',
    monthsAtCurrentAddress: 18,
    monthlyIncomeCents: 500_000,
  }

  it('accepts a complete form', () => {
    expect(validateApplicantForm(valid, now)).toEqual([])
  })

  it('requires a date of birth', () => {
    const violations = validateApplicantForm({ ...valid, dateOfBirth: null }, now)
    expect(violations.map((v) => v.field)).toEqual(['dateOfBirth'])
  })

  it('refuses a minor', () => {
    const violations = validateApplicantForm(
      { ...valid, dateOfBirth: new Date('2012-01-01T00:00:00Z') },
      now,
    )
    expect(violations.map((v) => v.field)).toEqual(['dateOfBirth'])
  })

  it('requires the current address fields', () => {
    const violations = validateApplicantForm(
      { ...valid, currentAddressLine1: '', currentCity: '' },
      now,
    )
    expect(violations.map((v) => v.field)).toEqual(
      expect.arrayContaining(['currentAddressLine1', 'currentCity']),
    )
  })

  it('requires a non-negative integer months-at-address', () => {
    const violations = validateApplicantForm({ ...valid, monthsAtCurrentAddress: -1 }, now)
    expect(violations.map((v) => v.field)).toEqual(['monthsAtCurrentAddress'])
  })

  it('requires a non-negative integer income', () => {
    const violations = validateApplicantForm({ ...valid, monthlyIncomeCents: null }, now)
    expect(violations.map((v) => v.field)).toEqual(['monthlyIncomeCents'])
  })

  it('requires an email or a phone', () => {
    const violations = validateApplicantForm({ ...valid, email: null }, now)
    expect(violations.map((v) => v.field)).toEqual(['email'])
  })
})

describe('applicationFeeCentsFor', () => {
  it('charges nothing when no fee is configured', () => {
    expect(applicationFeeCentsFor(null, 5_000)).toBe(0)
    expect(applicationFeeCentsFor(0, 5_000)).toBe(0)
  })

  it('charges the asking price when under (or with no) cap', () => {
    expect(applicationFeeCentsFor(4_000, 5_000)).toBe(4_000)
    expect(applicationFeeCentsFor(4_000, null)).toBe(4_000)
  })

  it('clamps to the cap when the asking price exceeds it', () => {
    expect(applicationFeeCentsFor(7_500, 5_000)).toBe(5_000)
  })

  it('charges exactly the cap when they are equal', () => {
    expect(applicationFeeCentsFor(5_000, 5_000)).toBe(5_000)
  })
})
