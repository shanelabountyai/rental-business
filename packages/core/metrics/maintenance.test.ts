import { describe, expect, it } from 'vitest'
import {
  costPerUnitPerMonth,
  firstResponseHours,
  reopenRate,
  repeatIssues,
  resolutionByPriority,
  vendorCosts,
} from './maintenance.ts'

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

describe('repeatIssues', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 0, n))
  const ticket = (id: string, unitId: string, category: string, n: number) => ({
    ticketId: id,
    unitId,
    category,
    createdAt: day(n),
  })

  it('finds two of the same category on the same unit inside the window', () => {
    const found = repeatIssues([
      ticket('t1', 'u1', 'PLUMBING', 1),
      ticket('t2', 'u1', 'PLUMBING', 40),
    ])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ unitId: 'u1', category: 'PLUMBING', count: 2 })
    expect(found[0].ticketIds).toEqual(['t1', 't2'])
  })

  it('does not pair two tickets more than the window apart', () => {
    expect(repeatIssues([ticket('t1', 'u1', 'PLUMBING', 1), ticket('t2', 'u1', 'PLUMBING', 200)])).toEqual([])
  })

  it('never pairs across units or across categories', () => {
    expect(
      repeatIssues([
        ticket('t1', 'u1', 'PLUMBING', 1),
        ticket('t2', 'u2', 'PLUMBING', 5),
        ticket('t3', 'u1', 'HVAC', 6),
      ]),
    ).toEqual([])
  })

  it('CHAINS a recurring problem rather than cutting it at the window', () => {
    // Four leaks eighty days apart are one chronic problem spanning most of
    // a year. A fixed window from the first ticket would report two
    // unrelated pairs and hide exactly the pattern this exists to find.
    const found = repeatIssues([
      ticket('t1', 'u1', 'PLUMBING', 1),
      ticket('t2', 'u1', 'PLUMBING', 81),
      ticket('t3', 'u1', 'PLUMBING', 161),
      ticket('t4', 'u1', 'PLUMBING', 241),
    ])
    expect(found).toHaveLength(1)
    expect(found[0].count).toBe(4)
    expect(found[0].firstAt).toEqual(day(1))
    expect(found[0].lastAt).toEqual(day(241))
  })

  it('splits into two chains when the gap breaks, keeping both', () => {
    const found = repeatIssues([
      ticket('t1', 'u1', 'PLUMBING', 1),
      ticket('t2', 'u1', 'PLUMBING', 10),
      ticket('t3', 'u1', 'PLUMBING', 300),
      ticket('t4', 'u1', 'PLUMBING', 310),
    ])
    expect(found).toHaveLength(2)
    expect(found.every((row) => row.count === 2)).toBe(true)
  })

  it('is not fooled by input order', () => {
    const found = repeatIssues([
      ticket('t2', 'u1', 'PLUMBING', 40),
      ticket('t1', 'u1', 'PLUMBING', 1),
    ])
    expect(found[0].ticketIds).toEqual(['t1', 't2'])
    expect(found[0].firstAt).toEqual(day(1))
  })

  it('sorts the longest chain first, then the most recent', () => {
    const found = repeatIssues([
      ticket('a1', 'u1', 'HVAC', 1),
      ticket('a2', 'u1', 'HVAC', 10),
      ticket('b1', 'u2', 'PLUMBING', 1),
      ticket('b2', 'u2', 'PLUMBING', 10),
      ticket('b3', 'u2', 'PLUMBING', 20),
    ])
    expect(found[0]).toMatchObject({ unitId: 'u2', count: 3 })
  })
})

describe('reopenRate', () => {
  const closedAt = new Date('2026-03-01T00:00:00Z')

  it('divides reopened jobs by CLOSED jobs, not by all jobs', () => {
    // An open job has not had its chance to be reopened yet; counting it
    // would let the rate improve simply by having a backlog.
    const rate = reopenRate([
      { closedAt, reopenCount: 1 },
      { closedAt, reopenCount: 0 },
      { closedAt: null, reopenCount: 0 },
      { closedAt: null, reopenCount: 0 },
    ])
    expect(rate).toEqual({ closed: 2, reopened: 1, rate: 0.5 })
  })

  it('counts a job reopened three times once', () => {
    expect(reopenRate([{ closedAt, reopenCount: 3 }])).toEqual({
      closed: 1,
      reopened: 1,
      rate: 1,
    })
  })

  it('returns null rather than 0% when nothing has closed', () => {
    // 0% off no jobs reads as a perfect record.
    expect(reopenRate([{ closedAt: null, reopenCount: 0 }])).toEqual({
      closed: 0,
      reopened: 0,
      rate: null,
    })
  })
})

describe('vendorCosts', () => {
  it('totals and averages per vendor, ranked by total spend', () => {
    const rows = vendorCosts([
      { vendorId: 'v1', costCents: 10_000 },
      { vendorId: 'v1', costCents: 20_000 },
      { vendorId: 'v2', costCents: 25_000 },
    ])
    expect(rows[0]).toEqual({ vendorId: 'v1', jobs: 2, totalCents: 30_000, averageCents: 15_000 })
    expect(rows[1]).toEqual({ vendorId: 'v2', jobs: 1, totalCents: 25_000, averageCents: 25_000 })
  })

  it('rounds the average to whole cents and leaves the total exact', () => {
    const rows = vendorCosts([
      { vendorId: 'v1', costCents: 10_000 },
      { vendorId: 'v1', costCents: 10_001 },
      { vendorId: 'v1', costCents: 10_001 },
    ])
    expect(rows[0].totalCents).toBe(30_002)
    expect(Number.isInteger(rows[0].averageCents)).toBe(true)
  })

  it('skips in-house work rather than bucketing it under a fake vendor', () => {
    expect(vendorCosts([{ vendorId: null, costCents: 5_000 }])).toEqual([])
  })
})
