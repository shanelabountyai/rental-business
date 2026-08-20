import { describe, expect, it } from 'vitest'
import { isPeriodicType, nextPeriodicDueDate } from './periodic.ts'

describe('isPeriodicType', () => {
  it('accepts the three calendar-driven types', () => {
    expect(isPeriodicType('PERIODIC')).toBe(true)
    expect(isPeriodicType('SEASONAL')).toBe(true)
    expect(isPeriodicType('DRIVE_BY')).toBe(true)
  })

  it('rejects the lease-event-driven types', () => {
    expect(isPeriodicType('MOVE_IN')).toBe(false)
    expect(isPeriodicType('MOVE_OUT')).toBe(false)
    expect(isPeriodicType('PRE_MOVE_OUT')).toBe(false)
  })
})

describe('nextPeriodicDueDate', () => {
  it('adds the annual interval for PERIODIC', () => {
    expect(nextPeriodicDueDate('2025-03-15', 'PERIODIC')).toBe('2026-03-15')
  })

  it('adds the semiannual interval for SEASONAL', () => {
    expect(nextPeriodicDueDate('2026-01-10', 'SEASONAL')).toBe('2026-07-10')
  })

  it('adds the quarterly interval for DRIVE_BY', () => {
    expect(nextPeriodicDueDate('2026-01-10', 'DRIVE_BY')).toBe('2026-04-10')
  })

  it('clamps a leap-day anchor to the real last day of a non-leap February', () => {
    expect(nextPeriodicDueDate('2024-02-29', 'PERIODIC')).toBe('2025-02-28')
  })

  it('clamps a 30-day-month anchor rolled forward into a shorter February', () => {
    expect(nextPeriodicDueDate('2025-11-30', 'DRIVE_BY')).toBe('2026-02-28')
  })
})
