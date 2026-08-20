import { describe, expect, it } from 'vitest'
import { renewalRate } from './leasing.ts'

describe('renewalRate', () => {
  it('counts a signed renewal successor as renewed', () => {
    const result = renewalRate([{ status: 'ENDED', renewalLeases: [{ id: 'l1' }] }])
    expect(result).toEqual({ renewed: 1, endedWithoutRenewal: 0, rate: 1 })
  })

  it('counts MONTH_TO_MONTH as renewed even with no successor lease', () => {
    const result = renewalRate([{ status: 'MONTH_TO_MONTH', renewalLeases: [] }])
    expect(result).toEqual({ renewed: 1, endedWithoutRenewal: 0, rate: 1 })
  })

  it('counts ENDED with no successor as not renewed', () => {
    const result = renewalRate([{ status: 'ENDED', renewalLeases: [] }])
    expect(result).toEqual({ renewed: 0, endedWithoutRenewal: 1, rate: 0 })
  })

  it('computes a blended rate across a mix', () => {
    const result = renewalRate([
      { status: 'ENDED', renewalLeases: [{ id: 'l1' }] },
      { status: 'MONTH_TO_MONTH', renewalLeases: [] },
      { status: 'ENDED', renewalLeases: [] },
      { status: 'ENDED', renewalLeases: [] },
    ])
    expect(result).toEqual({ renewed: 2, endedWithoutRenewal: 2, rate: 0.5 })
  })

  it('returns 0, not NaN, with nothing to report', () => {
    expect(renewalRate([])).toEqual({ renewed: 0, endedWithoutRenewal: 0, rate: 0 })
  })
})
