import { describe, expect, it } from 'vitest'
import { isFixableCondition } from './comparison.ts'

describe('isFixableCondition', () => {
  it('flags POOR, DAMAGED and MISSING', () => {
    expect(isFixableCondition('POOR')).toBe(true)
    expect(isFixableCondition('DAMAGED')).toBe(true)
    expect(isFixableCondition('MISSING')).toBe(true)
  })

  it('does not flag NEW, GOOD, FAIR, or nothing recorded yet', () => {
    expect(isFixableCondition('NEW')).toBe(false)
    expect(isFixableCondition('GOOD')).toBe(false)
    expect(isFixableCondition('FAIR')).toBe(false)
    expect(isFixableCondition(null)).toBe(false)
  })
})
