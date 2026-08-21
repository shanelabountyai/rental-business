import { describe, expect, it } from 'vitest'
import { nextComplianceDueDate } from './schedule.ts'

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
