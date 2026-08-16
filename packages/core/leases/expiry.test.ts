import { describe, expect, it } from 'vitest'
import { daysUntilExpiry, expiryWindow } from './expiry.ts'

describe('daysUntilExpiry', () => {
  it('counts forward to the term date', () => {
    expect(daysUntilExpiry('2026-11-13', '2026-08-15')).toBe(90)
  })

  it('IS NULL FOR A MONTH-TO-MONTH LEASE, not "expires never"', () => {
    // Not an edge case to special-case at the call site - a rolling tenancy
    // genuinely is not approaching a term, and the dashboard tile must not
    // count it.
    expect(daysUntilExpiry(null, '2026-08-15')).toBeNull()
  })

  it('goes negative for a term date already past, rather than clamping', () => {
    // Somebody forgot to roll it over or close it out - worth surfacing,
    // not silently dropping.
    expect(daysUntilExpiry('2026-08-01', '2026-08-15')).toBe(-14)
  })
})

describe('expiryWindow', () => {
  it('places a lease in the narrowest window it fits', () => {
    expect(expiryWindow(30)).toBe(90)
    expect(expiryWindow(90)).toBe(90)
    expect(expiryWindow(91)).toBe(120)
    expect(expiryWindow(120)).toBe(120)
  })

  it('is null past 120 days, and null covers "no term date" too', () => {
    expect(expiryWindow(121)).toBeNull()
    expect(expiryWindow(null)).toBeNull()
  })

  it('BUCKETS AN OVERDUE LEASE INTO THE NARROWEST WINDOW, as the most urgent case', () => {
    expect(expiryWindow(-14)).toBe(90)
  })
})
