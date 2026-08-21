import { describe, expect, it } from 'vitest'
import { endOfMonth, monthStartsBetween, startOfMonth } from '../scheduling/local-time.ts'
import type { ExportLine } from '../tax/export.ts'
import {
  UNATTRIBUTED_TRADE,
  availableFrom,
  monthlyPandL,
  operatingSnapshot,
  spendByTrade,
  tradeForJob,
  vacancyRate,
  vacantDaysInWindow,
} from './operating.ts'

const PROPERTY = 'prop_1'

function line(overrides: Partial<ExportLine> = {}): ExportLine {
  return {
    section: 'INCOME',
    bookedOn: '2026-03-04',
    propertyId: PROPERTY,
    propertyName: '12 Cedar Row',
    scheduleELine: 3,
    scheduleELabel: 'Rents received',
    quickBooksAccount: 'Rental Income',
    description: 'Rent',
    amountCents: 145_000,
    sourceKind: 'LedgerEntry',
    sourceId: 'led_1',
    ...overrides,
  }
}

describe('month helpers', () => {
  it('finds the first and last day of a month', () => {
    expect(startOfMonth('2026-03-17')).toBe('2026-03-01')
    expect(endOfMonth('2026-03-17')).toBe('2026-03-31')
  })

  it('knows how long February is, in both kinds of year', () => {
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28')
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29')
  })

  it('counts a partial month at either end as a month', () => {
    // A report that dropped March's four days would print a total that does
    // not match the sum of its own columns.
    expect(monthStartsBetween('2026-03-28', '2026-04-02')).toEqual(['2026-03-01', '2026-04-01'])
  })

  it('rolls over the year boundary', () => {
    expect(monthStartsBetween('2026-11-15', '2027-02-03')).toEqual([
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ])
  })

  it('gives one month for a range inside one month, and none for a backwards range', () => {
    expect(monthStartsBetween('2026-03-02', '2026-03-29')).toEqual(['2026-03-01'])
    expect(monthStartsBetween('2026-04-01', '2026-03-01')).toEqual([])
  })
})

describe('vacant days in a window', () => {
  const window = { from: '2026-01-01', to: '2026-12-31', availableFrom: '2020-01-01' }

  it('counts a whole year empty when there was never a tenant', () => {
    expect(vacantDaysInWindow({ ...window, intervals: [] })).toBe(365)
  })

  it('counts nothing when a tenant was there the whole time', () => {
    expect(
      vacantDaysInWindow({
        ...window,
        intervals: [{ movedInOn: '2025-06-01', movedOutOn: null }],
      }),
    ).toBe(0)
  })

  it('counts the gap between two tenancies', () => {
    // Out on 1 March, in on 1 April. The move-out day counts as vacant and
    // the move-in day does not, matching `daysOnMarket` - so 1..31 March.
    expect(
      vacantDaysInWindow({
        ...window,
        intervals: [
          { movedInOn: '2025-01-01', movedOutOn: '2026-03-01' },
          { movedInOn: '2026-04-01', movedOutOn: null },
        ],
      }),
    ).toBe(31)
  })

  it('clips a tenancy that starts before the window', () => {
    expect(
      vacantDaysInWindow({
        ...window,
        intervals: [{ movedInOn: '2024-05-01', movedOutOn: '2026-01-11' }],
      }),
    ).toBe(365 - 10)
  })

  it('never counts days before the unit was the owner’s problem', () => {
    // Acquired 1 July. The first half of the year belonged to somebody else,
    // and counting it would make every new property the worst performer.
    expect(
      vacantDaysInWindow({ ...window, availableFrom: '2026-07-01', intervals: [] }),
    ).toBe(184)
  })

  it('returns zero when the unit was acquired after the window closed', () => {
    expect(
      vacantDaysInWindow({ ...window, availableFrom: '2027-03-01', intervals: [] }),
    ).toBe(0)
  })

  it('floors at zero rather than reporting negative vacancy on overlapping leases', () => {
    // A data error, but not one this report may turn into a negative number.
    expect(
      vacantDaysInWindow({
        ...window,
        intervals: [
          { movedInOn: '2026-01-01', movedOutOn: null },
          { movedInOn: '2026-01-01', movedOutOn: null },
        ],
      }),
    ).toBe(0)
  })
})

describe('when a unit started being able to earn', () => {
  it('takes the acquisition date when it is recorded', () => {
    expect(
      availableFrom({
        acquiredOn: '2019-04-01',
        propertyCreatedOn: '2026-08-21',
        earliestTenancyOn: '2020-01-01',
      }),
    ).toBe('2019-04-01')
  })

  it('never lets a row’s createdAt delete history', () => {
    // THE MIGRATION CASE. Type a portfolio in on a Tuesday and every unit's
    // `createdAt` is that Tuesday - so a lease that started in 2024 is
    // evidence the unit existed, and the vacancy before it is real.
    expect(
      availableFrom({
        acquiredOn: null,
        propertyCreatedOn: '2026-08-21',
        earliestTenancyOn: '2024-01-01',
      }),
    ).toBe('2024-01-01')
  })

  it('falls back to the property row when there is no tenancy at all', () => {
    expect(
      availableFrom({
        acquiredOn: null,
        propertyCreatedOn: '2026-08-21',
        earliestTenancyOn: null,
      }),
    ).toBe('2026-08-21')
  })

  it('does not reach back past the property row for a later tenancy', () => {
    expect(
      availableFrom({
        acquiredOn: null,
        propertyCreatedOn: '2026-01-01',
        earliestTenancyOn: '2026-06-01',
      }),
    ).toBe('2026-01-01')
  })
})

describe('attributing a job to a trade', () => {
  it('takes the ticket category first — what actually broke', () => {
    expect(tradeForJob({ ticketCategory: 'PLUMBING', pmTemplateTrade: 'hvac' })).toBe('PLUMBING')
  })

  it('falls back to the preventive template for a batch job with no ticket', () => {
    expect(tradeForJob({ ticketCategory: null, pmTemplateTrade: 'hvac' })).toBe('HVAC')
  })

  it('folds case, because the two vocabularies were never unified', () => {
    // `Ticket.category` is an uppercase enum; `PreventiveMaintenanceTemplate.trade`
    // is lowercase free text. Unfolded, one trade becomes two columns.
    expect(tradeForJob({ ticketCategory: null, pmTemplateTrade: 'plumbing' })).toBe(
      tradeForJob({ ticketCategory: 'PLUMBING', pmTemplateTrade: null }),
    )
  })

  it('buckets rather than drops when nobody recorded a trade', () => {
    expect(tradeForJob({ ticketCategory: null, pmTemplateTrade: null })).toBe(UNATTRIBUTED_TRADE)
    expect(tradeForJob({ ticketCategory: null, pmTemplateTrade: '  ' })).toBe(UNATTRIBUTED_TRADE)
  })

  it('sums to the total spend — the columns cannot exceed the whole', () => {
    const jobs = [
      { trade: 'PLUMBING', costCents: 30_000 },
      { trade: 'HVAC', costCents: 50_000 },
      { trade: 'PLUMBING', costCents: 20_000 },
      { trade: UNATTRIBUTED_TRADE, costCents: 5_000 },
    ]
    const byTrade = spendByTrade(jobs)
    expect(byTrade.reduce((total, row) => total + row.costCents, 0)).toBe(105_000)
    // Biggest first: the report exists to show where the money goes. These
    // two tie at 50,000, so the alphabetical tie-break decides - and it must,
    // or the same data would order differently between two runs.
    expect(byTrade[0]).toEqual({ trade: 'HVAC', costCents: 50_000, jobCount: 1 })
    expect(byTrade[1]).toEqual({ trade: 'PLUMBING', costCents: 50_000, jobCount: 2 })
    expect(byTrade[2]?.trade).toBe(UNATTRIBUTED_TRADE)
  })
})

describe('monthly P&L', () => {
  const properties = [{ id: PROPERTY, name: '12 Cedar Row' }]

  it('gives every month in the window a row, including the empty ones', () => {
    const result = monthlyPandL({
      lines: [line()],
      properties,
      from: '2026-01-01',
      to: '2026-12-31',
    })
    expect(result[0]?.months).toHaveLength(12)
    expect(result[0]?.months[0]).toEqual({
      month: '2026-01-01',
      incomeCents: 0,
      expenseCents: 0,
      netCents: 0,
    })
  })

  it('books each line into the month it happened in', () => {
    const result = monthlyPandL({
      lines: [
        line({ sourceId: 'a', bookedOn: '2026-03-04', amountCents: 145_000 }),
        line({ sourceId: 'b', bookedOn: '2026-04-02', amountCents: 150_000 }),
        line({
          sourceId: 'c',
          section: 'EXPENSE',
          scheduleELine: 14,
          bookedOn: '2026-03-20',
          amountCents: 26_000,
        }),
      ],
      properties,
      from: '2026-01-01',
      to: '2026-12-31',
    })
    const march = result[0]?.months.find((m) => m.month === '2026-03-01')
    expect(march).toEqual({
      month: '2026-03-01',
      incomeCents: 145_000,
      expenseCents: 26_000,
      netCents: 119_000,
    })
    expect(result[0]?.netCents).toBe(145_000 + 150_000 - 26_000)
  })

  it('keeps CapEx and deposits out of the operating P&L', () => {
    // The roof is depreciated, not charged against the month it was fitted;
    // a deposit is money held, not income (D-71).
    const result = monthlyPandL({
      lines: [
        line({ sourceId: 'capex', section: 'CAPEX', scheduleELine: null, amountCents: 1_450_000 }),
        line({
          sourceId: 'dep',
          section: 'DEPOSIT_LIABILITY',
          scheduleELine: null,
          amountCents: 145_000,
        }),
      ],
      properties,
      from: '2026-01-01',
      to: '2026-12-31',
    })
    expect(result[0]?.incomeCents).toBe(0)
    expect(result[0]?.expenseCents).toBe(0)
  })

  it('ignores another property’s lines', () => {
    const result = monthlyPandL({
      lines: [line({ propertyId: 'prop_other' })],
      properties,
      from: '2026-01-01',
      to: '2026-12-31',
    })
    expect(result[0]?.incomeCents).toBe(0)
  })
})

describe('the lemon view', () => {
  const pandl = [
    {
      propertyId: 'good',
      propertyName: 'Good House',
      months: [],
      incomeCents: 1_800_000,
      expenseCents: 200_000,
      netCents: 1_600_000,
    },
    {
      propertyId: 'lemon',
      propertyName: 'Lemon House',
      months: [],
      incomeCents: 900_000,
      expenseCents: 1_400_000,
      netCents: -500_000,
    },
  ]

  it('puts the worst net first — a list sorted by name buries the lemon', () => {
    const rows = operatingSnapshot({
      pandl,
      lines: [],
      unitCounts: new Map(),
      vacantDays: new Map(),
      availableDays: new Map(),
      ticketCounts: new Map(),
      turnCosts: new Map(),
    })
    expect(rows.map((row) => row.propertyId)).toEqual(['lemon', 'good'])
  })

  it('counts repairs and turn cleaning as maintenance spend, and nothing else', () => {
    const rows = operatingSnapshot({
      pandl: [pandl[0]],
      lines: [
        line({ propertyId: 'good', section: 'EXPENSE', scheduleELine: 14, amountCents: 26_000 }),
        line({ propertyId: 'good', section: 'EXPENSE', scheduleELine: 7, amountCents: 40_000 }),
        // Legal fees and utilities are expenses, but not MAINTENANCE spend -
        // folding them in would make the lemon test meaningless.
        line({ propertyId: 'good', section: 'EXPENSE', scheduleELine: 10, amountCents: 90_000 }),
        line({ propertyId: 'good', section: 'EXPENSE', scheduleELine: 17, amountCents: 4_200 }),
      ],
      unitCounts: new Map([['good', 1]]),
      vacantDays: new Map(),
      availableDays: new Map(),
      ticketCounts: new Map(),
      turnCosts: new Map(),
    })
    expect(rows[0]?.maintenanceSpendCents).toBe(66_000)
    expect(rows[0]?.expenseCents).toBe(200_000)
  })
})

describe('vacancy rate', () => {
  it('is a share of the days that could have been let', () => {
    expect(vacancyRate({ vacantDays: 73, availableDays: 365 })).toBeCloseTo(0.2)
  })

  it('is null, never zero, when nothing was available', () => {
    // A property acquired after the window closed has no rate. Showing 0%
    // would read as "never empty".
    expect(vacancyRate({ vacantDays: 0, availableDays: 0 })).toBeNull()
  })
})
