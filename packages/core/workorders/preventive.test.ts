import { describe, expect, it } from 'vitest'
import { nextPreventiveDueDate } from './preventive.ts'

describe('nextPreventiveDueDate', () => {
  it('adds a semiannual interval (HVAC spring/fall)', () => {
    expect(nextPreventiveDueDate('2026-03-01', 6)).toBe('2026-09-01')
  })

  it('adds an annual interval (water heater flush)', () => {
    expect(nextPreventiveDueDate('2025-06-15', 12)).toBe('2026-06-15')
  })

  it('adds a quarterly interval (pest control)', () => {
    expect(nextPreventiveDueDate('2026-01-10', 3)).toBe('2026-04-10')
  })

  it('clamps a leap-day anchor to the real last day of a non-leap February', () => {
    expect(nextPreventiveDueDate('2024-02-29', 12)).toBe('2025-02-28')
  })

  it('clamps a 30-day-month anchor rolled forward into a shorter February', () => {
    expect(nextPreventiveDueDate('2025-11-30', 3)).toBe('2026-02-28')
  })
})
