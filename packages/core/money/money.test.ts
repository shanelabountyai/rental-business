import { describe, expect, it } from 'vitest'
import {
  allocate,
  daysPastDue,
  dollarsToCents,
  formatCents,
  prorateRent,
} from './money.ts'

describe('cents conversion', () => {
  it('rounds fractional cents on the way in', () => {
    expect(dollarsToCents(1850.005)).toBe(185001)
    expect(dollarsToCents(1850)).toBe(185000)
  })

  it('rejects non-integer cents', () => {
    expect(() => formatCents(1234.5)).toThrow(TypeError)
  })
})

describe('prorateRent', () => {
  it('prorates on actual days in the month', () => {
    expect(
      prorateRent({
        monthlyRentCents: 185000,
        daysOccupied: 12,
        daysInMonth: 31,
        method: 'actual',
      }),
    ).toBe(71613)
  })

  it('prorates on a flat 30-day month', () => {
    expect(
      prorateRent({
        monthlyRentCents: 185000,
        daysOccupied: 12,
        daysInMonth: 31,
        method: 'banker30',
      }),
    ).toBe(74000)
  })

  it('returns the full month when occupied every day', () => {
    expect(
      prorateRent({
        monthlyRentCents: 185000,
        daysOccupied: 28,
        daysInMonth: 28,
        method: 'actual',
      }),
    ).toBe(185000)
  })

  it('rejects more days occupied than the month has', () => {
    expect(() =>
      prorateRent({
        monthlyRentCents: 185000,
        daysOccupied: 32,
        daysInMonth: 31,
        method: 'actual',
      }),
    ).toThrow(RangeError)
  })
})

describe('allocate', () => {
  it('never loses or invents a cent', () => {
    const parts = allocate(10000, [1, 1, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000)
    expect(parts).toEqual([3334, 3333, 3333])
  })

  it('splits proportionally by weight', () => {
    const parts = allocate(30000, [2, 1])
    expect(parts).toEqual([20000, 10000])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(30000)
  })

  it('is deterministic when fractional parts tie', () => {
    expect(allocate(101, [1, 1])).toEqual([51, 50])
    expect(allocate(101, [1, 1])).toEqual([51, 50])
  })

  it('handles a zero-weight participant', () => {
    expect(allocate(1000, [1, 0])).toEqual([1000, 0])
  })

  it('rejects weights that sum to zero', () => {
    expect(() => allocate(1000, [0, 0])).toThrow(RangeError)
  })
})

describe('daysPastDue', () => {
  it('counts from the due date', () => {
    expect(daysPastDue('2026-08-01', '2026-08-06')).toBe(5)
  })

  it('is ZERO on the due date, whatever time of day it is anywhere', () => {
    // The regression this signature exists to prevent. The original took two
    // Date objects and read them with the local getters, so a `@db.Date`
    // (UTC midnight) compared against a real timestamp reported 1 on the due
    // date itself for any server west of UTC - a late fee a day early, on
    // every property, every month.
    expect(daysPastDue('2026-08-01', '2026-08-01')).toBe(0)
  })

  it('is zero on the due date and before it', () => {
    expect(daysPastDue('2026-08-01', '2026-08-01')).toBe(0)
    expect(daysPastDue('2026-08-01', '2026-07-28')).toBe(0)
  })

  it('cannot be handed a time of day at all - that is the point', () => {
    // A BusinessDate is a calendar day, so "late evening" is not a thing
    // that can be expressed here, which is what makes the off-by-one
    // unrepresentable rather than merely tested against.
    expect(daysPastDue('2026-08-01', '2026-08-06')).toBe(5)
  })

  it('counts calendar days across a daylight-saving change', () => {
    // 8 March 2026 is a US spring-forward. Counting in elapsed hours would
    // lose one and report 30 where 31 days have passed.
    expect(daysPastDue('2026-03-01', '2026-04-01')).toBe(31)
  })
})
