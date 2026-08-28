import { describe, expect, it } from 'vitest'
import { complianceToday, nextComplianceDueDate } from './schedule.ts'

describe('nextComplianceDueDate', () => {
  it('advances by the recurrence, anchored to the completion date', () => {
    expect(nextComplianceDueDate('2026-01-15', 12)).toBe('2027-01-15')
    expect(nextComplianceDueDate('2026-01-15', 6)).toBe('2026-07-15')
  })

  it('rolls the year over correctly', () => {
    expect(nextComplianceDueDate('2026-11-01', 3)).toBe('2027-02-01')
  })

  it('clamps to the target month\'s real last day - Feb 29 plus 12 months', () => {
    expect(nextComplianceDueDate('2024-02-29', 12)).toBe('2025-02-28')
  })

  it('clamps a 31st into a 30-day month', () => {
    expect(nextComplianceDueDate('2026-01-31', 1)).toBe('2026-02-28')
  })
})

describe('complianceToday', () => {
  // 01:14 UTC on 29 Aug is still 20:14 on 28 Aug in Houston - the window in
  // which a UTC "today" calls a filing due 28 Aug overdue and the property's
  // own clock does not.
  const lateEvening = new Date('2026-08-29T01:14:00Z')

  it("is the property's own local day, not UTC's", () => {
    expect(complianceToday(lateEvening, ['America/Chicago'])).toBe('2026-08-28')
    expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-08-29')
  })

  it('takes the earliest local day across an entity\'s properties', () => {
    // 02:00 on the 29th in New York, still 20:00 on the 28th in Honolulu.
    const split = new Date('2026-08-29T06:00:00Z')
    expect(complianceToday(split, ['America/New_York', 'Pacific/Honolulu'])).toBe('2026-08-28')
    // and once it is the 29th in both, it is the 29th.
    expect(complianceToday(new Date('2026-08-29T12:00:00Z'), ['America/New_York', 'Pacific/Honolulu'])).toBe(
      '2026-08-29',
    )
  })

  it('has no day at all for an item with no property behind it', () => {
    expect(complianceToday(lateEvening, [])).toBeNull()
  })
})
