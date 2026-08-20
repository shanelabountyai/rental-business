import { describe, expect, it } from 'vitest'
import { costPerUnitPerMonth, firstResponseHours, resolutionByPriority } from './maintenance.ts'

describe('firstResponseHours', () => {
  it('returns hours between creation and first response', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const firstResponseAt = new Date('2026-01-01T02:30:00Z')
    expect(firstResponseHours({ createdAt, firstResponseAt })).toBe(2.5)
  })

  it('returns null while still waiting', () => {
    expect(
      firstResponseHours({ createdAt: new Date('2026-01-01T00:00:00Z'), firstResponseAt: null }),
    ).toBeNull()
  })
})

describe('resolutionByPriority', () => {
  it('averages hours to close per priority, every priority present even at zero', () => {
    const tickets = [
      {
        priority: 'EMERGENCY',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        closedAt: new Date('2026-01-01T04:00:00Z'),
      },
      {
        priority: 'EMERGENCY',
        createdAt: new Date('2026-01-02T00:00:00Z'),
        closedAt: new Date('2026-01-02T08:00:00Z'),
      },
      {
        priority: 'ROUTINE',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        closedAt: new Date('2026-01-03T00:00:00Z'), // 48h
      },
    ]

    const result = resolutionByPriority(tickets)
    expect(result.EMERGENCY).toEqual({ count: 2, avgHours: 6 })
    expect(result.ROUTINE).toEqual({ count: 1, avgHours: 48 })
    expect(result.URGENT).toEqual({ count: 0, avgHours: null }) // present, zero, not omitted
  })

  it('excludes a still-open ticket from the average, not just its count', () => {
    const tickets = [
      { priority: 'URGENT', createdAt: new Date('2026-01-01T00:00:00Z'), closedAt: null },
    ]
    const result = resolutionByPriority(tickets)
    expect(result.URGENT).toEqual({ count: 0, avgHours: null })
  })
})

describe('costPerUnitPerMonth', () => {
  it('divides total cost by units and months', () => {
    expect(costPerUnitPerMonth({ totalCostCents: 120_000, unitCount: 10, months: 3 })).toBe(4_000)
  })

  it('returns 0 rather than dividing by zero units', () => {
    expect(costPerUnitPerMonth({ totalCostCents: 50_000, unitCount: 0, months: 1 })).toBe(0)
  })

  it('returns 0 rather than dividing by zero months', () => {
    expect(costPerUnitPerMonth({ totalCostCents: 50_000, unitCount: 5, months: 0 })).toBe(0)
  })
})
