import { describe, expect, it } from 'vitest'
import { conditionChange, isFixableCondition } from './comparison.ts'

describe('conditionChange', () => {
  it('is unknown when either side has not been walked yet', () => {
    expect(conditionChange(null, 'GOOD')).toBe('unknown')
    expect(conditionChange('GOOD', null)).toBe('unknown')
  })

  it('detects a decline', () => {
    expect(conditionChange('NEW', 'FAIR')).toBe('declined')
    expect(conditionChange('GOOD', 'MISSING')).toBe('declined')
  })

  it('detects an improvement (a repair between walks)', () => {
    expect(conditionChange('POOR', 'GOOD')).toBe('improved')
  })

  it('detects no change', () => {
    expect(conditionChange('GOOD', 'GOOD')).toBe('same')
  })
})

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
