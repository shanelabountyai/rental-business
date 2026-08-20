import { describe, expect, it } from 'vitest'
import { daysToFill } from './vacancy.ts'

describe('daysToFill', () => {
  it('counts from vacated to filled, and reports final once filled', () => {
    const result = daysToFill({ vacatedOn: '2026-01-01', filledOn: '2026-01-15', asOf: '2026-02-01' })
    expect(result).toEqual({ days: 14, isFinal: true })
  })

  it('counts from vacated to asOf, and reports not final while still vacant', () => {
    const result = daysToFill({ vacatedOn: '2026-01-01', filledOn: null, asOf: '2026-01-10' })
    expect(result).toEqual({ days: 9, isFinal: false })
  })

  it('never goes negative', () => {
    const result = daysToFill({ vacatedOn: '2026-01-10', filledOn: null, asOf: '2026-01-05' })
    expect(result.days).toBe(0)
  })

  it('filled the same day it vacated is zero days, final', () => {
    const result = daysToFill({ vacatedOn: '2026-01-01', filledOn: '2026-01-01', asOf: '2026-02-01' })
    expect(result).toEqual({ days: 0, isFinal: true })
  })
})
