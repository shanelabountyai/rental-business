import { describe, expect, it } from 'vitest'
import { dailyCostOfVacancyCents, daysOnMarket } from './vacancy.ts'

describe('daysOnMarket', () => {
  it('counts from the most recent move-out', () => {
    expect(
      daysOnMarket({ lastMoveOutAt: '2026-08-01', unitCreatedAt: '2020-01-01', asOf: '2026-08-15' }),
    ).toBe(14)
  })

  it('FALLS BACK TO WHEN THE UNIT WAS ADDED for a unit never leased', () => {
    // No moveOutAt at all - a genuinely brand-new unit. The day it entered
    // the portfolio is the day it started being "on the market" in every
    // sense an owner cares about.
    expect(
      daysOnMarket({ lastMoveOutAt: null, unitCreatedAt: '2026-08-10', asOf: '2026-08-15' }),
    ).toBe(5)
  })

  it('never goes negative', () => {
    // A unit added or vacated today.
    expect(
      daysOnMarket({ lastMoveOutAt: '2026-08-15', unitCreatedAt: '2020-01-01', asOf: '2026-08-15' }),
    ).toBe(0)
  })
})

describe('dailyCostOfVacancyCents', () => {
  it('divides the monthly asking rent by thirty', () => {
    expect(dailyCostOfVacancyCents(150_000)).toBe(5_000)
  })

  it('returns NULL, not zero, for a unit with no asking rent on file', () => {
    // Zero would read as "costing nothing"; null is "not priced yet".
    expect(dailyCostOfVacancyCents(null)).toBeNull()
  })

  it('rounds to the nearest cent', () => {
    expect(dailyCostOfVacancyCents(100_000)).toBe(3_333)
  })
})
