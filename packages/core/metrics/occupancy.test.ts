import { describe, expect, it } from 'vitest'
import { occupancyRate } from './occupancy.ts'

describe('occupancyRate', () => {
  it('divides occupied by total', () => {
    expect(occupancyRate({ occupied: 8, total: 10 })).toBe(0.8)
  })

  it('returns 0, not NaN, with no units at all', () => {
    expect(occupancyRate({ occupied: 0, total: 0 })).toBe(0)
  })

  it('is 1 when every unit is occupied', () => {
    expect(occupancyRate({ occupied: 5, total: 5 })).toBe(1)
  })

  it('counts a DOWN unit as not occupied - occupied/total never excludes it', () => {
    // 3 occupied out of 5 total, one of the other two being DOWN rather than
    // VACANT - the caller passes total unit count, not "rentable" count, so
    // this reads 0.6, not 0.75 (which would exclude the DOWN unit).
    expect(occupancyRate({ occupied: 3, total: 5 })).toBe(0.6)
  })
})
