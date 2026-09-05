// The per-property operating report (RPT-05, R-081a) - the "which house is a
// lemon" view, and the monthly P&L behind it.
//
// ===========================================================================
// THIS IS AN OPERATING P&L, NOT A GENERAL LEDGER. RPT-09 makes full financial
// statements an explicit Won't - "QuickBooks' job" - so nothing here tries to
// balance, carry a retained-earnings figure, or reconcile to a trial balance.
// It answers one question: over this period, per property, what came in, what
// went out, how many days sat empty, and how many times somebody called.
// ===========================================================================
//
// The income and expense rows are NOT re-fetched here. They are the same
// `ExportLine`s R-078's `buildTaxExport` already produces, grouped by
// property and month. Building a second income/expense pipeline would mean a
// second copy of the ledger sign-flip rule, the capitalised-job exclusion and
// the timezone-at-a-period-boundary rule - each of which is silent when wrong
// and each of which has a comment in `export.ts` explaining why.

import { addBusinessDays, businessDaysBetween, monthStartsBetween } from '../scheduling/local-time.ts'
import type { BusinessDate } from '../scheduling/local-time.ts'
import type { ExportLine } from '../tax/export.ts'

/**
 * One stretch of a unit being lived in.
 *
 * `movedOutOn` is EXCLUSIVE - the move-out day counts as a vacant day, which
 * is the convention `daysOnMarket` (`packages/core/units/vacancy.ts`) already
 * uses when it measures from `lastMoveOutAt`. The two numbers would otherwise
 * disagree by one day for every turn, and the vacancy report and the
 * vacancies page would be visibly inconsistent about the same unit.
 *
 * Null means still in residence.
 */
export interface OccupiedInterval {
  movedInOn: BusinessDate
  movedOutOn: BusinessDate | null
}

/**
 * Days a single unit sat empty inside `[from, to]`, both ends inclusive.
 *
 * `availableFrom` is when the unit became this owner's problem - its creation
 * date, or the day the property was acquired. Days before it are not vacancy,
 * they are days somebody else owned the house, and counting them would make
 * every newly-added property look like the worst performer in the portfolio.
 */
export function vacantDaysInWindow(facts: {
  intervals: readonly OccupiedInterval[]
  from: BusinessDate
  to: BusinessDate
  availableFrom: BusinessDate
}): number {
  // BusinessDate is `YYYY-MM-DD`, so lexicographic order IS chronological
  // order. That is the whole reason the type is a string rather than a Date.
  const start = facts.availableFrom > facts.from ? facts.availableFrom : facts.from
  const endExclusive = addBusinessDays(facts.to, 1)
  if (start >= endExclusive) return 0

  const totalDays = businessDaysBetween(start, endExclusive)

  let occupied = 0
  for (const interval of facts.intervals) {
    const overlapStart = interval.movedInOn > start ? interval.movedInOn : start
    const intervalEnd = interval.movedOutOn ?? endExclusive
    const overlapEnd = intervalEnd < endExclusive ? intervalEnd : endExclusive
    if (overlapStart >= overlapEnd) continue
    occupied += businessDaysBetween(overlapStart, overlapEnd)
  }

  // Floored rather than trusted: two leases that overlap - a data error, but
  // one this report must not turn into a negative vacancy figure - would
  // otherwise push the total below zero.
  return Math.max(0, totalDays - occupied)
}

/// An occupied stretch with the rent it was occupied AT - a unit re-let
/// mid-period at a different rent has two of these, not one.
export interface RentedInterval extends OccupiedInterval {
  rentCents: number
}

/**
 * What rent was actually scheduled to bill across `[from, to]` - the
 * contract-rent counterpart to `vacantDaysInWindow`'s empty days, using the
 * same flat thirty-day month `dailyCostOfVacancyCents`
 * (`packages/core/units/vacancy.ts`) already uses for a day's cost. This is
 * the "scheduled" side of economic occupancy (review §12): what tenants
 * actually agreed to pay for their occupied days, as distinct from what was
 * COLLECTED, which a delinquency can make smaller.
 */
export function scheduledRentCentsInWindow(facts: {
  intervals: readonly RentedInterval[]
  from: BusinessDate
  to: BusinessDate
}): number {
  const endExclusive = addBusinessDays(facts.to, 1)
  let total = 0
  for (const interval of facts.intervals) {
    const overlapStart = interval.movedInOn > facts.from ? interval.movedInOn : facts.from
    const intervalEnd = interval.movedOutOn ?? endExclusive
    const overlapEnd = intervalEnd < endExclusive ? intervalEnd : endExclusive
    if (overlapStart >= overlapEnd) continue
    const days = businessDaysBetween(overlapStart, overlapEnd)
    total += Math.round((interval.rentCents / 30) * days)
  }
  return total
}

/**
 * The day a unit started being able to earn for this owner.
 *
 * ==========================================================================
 * A ROW'S `createdAt` IS NOT A FACT ABOUT THE WORLD. It is when somebody
 * typed the unit into this software, and using it as the floor deletes
 * history: migrate a portfolio in and every unit's `createdAt` is the
 * migration date, so every vacancy before that Tuesday silently becomes zero
 * and a house that sat empty for a season reports perfect occupancy.
 *
 * `acquiredOn` is the real fact and wins whenever it is recorded. Without it,
 * the earliest thing that can be honestly claimed is the earlier of "the
 * property row existed" and "a tenancy had already started" - a lease that
 * predates the row is itself evidence the unit was there, and backfilled
 * history is exactly the case that matters.
 * ==========================================================================
 */
export function availableFrom(facts: {
  acquiredOn: BusinessDate | null
  propertyCreatedOn: BusinessDate
  earliestTenancyOn: BusinessDate | null
}): BusinessDate {
  if (facts.acquiredOn != null) return facts.acquiredOn
  const { propertyCreatedOn, earliestTenancyOn } = facts
  if (earliestTenancyOn != null && earliestTenancyOn < propertyCreatedOn) return earliestTenancyOn
  return propertyCreatedOn
}

/// The bucket for spend whose trade nobody recorded. Present in the output
/// rather than dropped, for the same reason R-078's export carries an
/// exception list: a total that quietly excludes what it could not classify
/// is a total somebody will act on.
export const UNATTRIBUTED_TRADE = 'UNATTRIBUTED'

/**
 * Which trade a job's cost belongs to.
 *
 * ==========================================================================
 * DELIBERATELY NOT `Vendor.trades`, for two independent reasons.
 *
 * It is a LIST. A vendor registered for `['plumbing', 'hvac']` has no single
 * trade, so attributing their jobs by it either double-counts the money or
 * picks one arbitrarily - and a spend-by-trade report whose columns sum to
 * more than the total spend is worse than no report.
 *
 * It is also the wrong FACT. A vendor's trades are what they are able to do;
 * this report asks what the work WAS. A plumber who hangs a door on the same
 * visit did carpentry, whatever their registration says.
 *
 * So: the ticket's own category first (a real enum, and the closest thing to
 * a statement of what broke), then the preventive template's trade for the
 * batch jobs R-080 creates with no ticket behind them, then the honest
 * bucket.
 * ==========================================================================
 *
 * Normalised to upper case because the two vocabularies were never unified -
 * `Ticket.category` is an uppercase enum, `Vendor.trades` and
 * `PreventiveMaintenanceTemplate.trade` are lowercase free text
 * (`apps/web/lib/workorders/queries.ts` documents the same mismatch). Folding
 * case here means `PLUMBING` and `plumbing` cannot become two columns.
 */
export function tradeForJob(facts: {
  ticketCategory: string | null
  pmTemplateTrade: string | null
}): string {
  const chosen = facts.ticketCategory ?? facts.pmTemplateTrade
  const trimmed = chosen?.trim()
  return trimmed ? trimmed.toUpperCase() : UNATTRIBUTED_TRADE
}

export interface TradeSpend {
  trade: string
  costCents: number
  jobCount: number
}

/// Spend grouped by trade, biggest first. Ties break on trade name so the
/// order is stable between two runs of the same report.
export function spendByTrade(
  jobs: readonly { trade: string; costCents: number }[],
): TradeSpend[] {
  const totals = new Map<string, TradeSpend>()
  for (const job of jobs) {
    const row = totals.get(job.trade) ?? { trade: job.trade, costCents: 0, jobCount: 0 }
    row.costCents += job.costCents
    row.jobCount += 1
    totals.set(job.trade, row)
  }
  return [...totals.values()].sort(
    (a, b) => b.costCents - a.costCents || a.trade.localeCompare(b.trade),
  )
}

export interface MonthCell {
  month: BusinessDate
  incomeCents: number
  expenseCents: number
  netCents: number
}

export interface PropertyPandL {
  propertyId: string
  propertyName: string
  months: MonthCell[]
  incomeCents: number
  expenseCents: number
  netCents: number
}

/**
 * Monthly P&L per property, from the export's own classified lines.
 *
 * CAPEX AND DEPOSIT ROWS ARE EXCLUDED, and both exclusions are the point of
 * the sections existing. A capital improvement is not an operating expense -
 * it is depreciated, and charging the whole roof against the month it was
 * fitted would show a catastrophic month and eleven flattering ones. A
 * security deposit is not income; it is money held (R-078's D-71).
 *
 * Every month in the window gets a row even when nothing happened in it. A
 * missing month reads as a gap in the data rather than as a quiet one, and
 * the columns have to line up across properties to be comparable at all.
 */
export function monthlyPandL(input: {
  lines: readonly ExportLine[]
  properties: readonly { id: string; name: string }[]
  from: BusinessDate
  to: BusinessDate
}): PropertyPandL[] {
  const months = monthStartsBetween(input.from, input.to)

  return input.properties.map((property) => {
    const cells = new Map<BusinessDate, MonthCell>(
      months.map((month) => [month, { month, incomeCents: 0, expenseCents: 0, netCents: 0 }]),
    )

    for (const line of input.lines) {
      if (line.propertyId !== property.id) continue
      if (line.section !== 'INCOME' && line.section !== 'EXPENSE') continue
      if (line.bookedOn == null) continue
      const cell = cells.get(`${line.bookedOn.slice(0, 7)}-01`)
      if (!cell) continue
      if (line.section === 'INCOME') cell.incomeCents += line.amountCents
      else cell.expenseCents += line.amountCents
    }

    const ordered = months.map((month) => {
      const cell = cells.get(month)!
      cell.netCents = cell.incomeCents - cell.expenseCents
      return cell
    })

    const incomeCents = ordered.reduce((total, cell) => total + cell.incomeCents, 0)
    const expenseCents = ordered.reduce((total, cell) => total + cell.expenseCents, 0)
    return {
      propertyId: property.id,
      propertyName: property.name,
      months: ordered,
      incomeCents,
      expenseCents,
      netCents: incomeCents - expenseCents,
    }
  })
}

export interface PropertySnapshot {
  propertyId: string
  propertyName: string
  unitCount: number
  incomeCents: number
  /// Repairs plus turn cleaning only - NOT every expense. RPT-05 names
  /// "maintenance spend" as its own column beside income, and lumping legal
  /// fees and utilities into it would make the lemon test meaningless.
  maintenanceSpendCents: number
  expenseCents: number
  netCents: number
  vacantDays: number
  /// Days a unit could have been occupied - `unitCount × window length`,
  /// clipped at each unit's own availability. The denominator that makes
  /// vacancy comparable between a one-unit house and a fourplex.
  availableDays: number
  ticketCount: number
  turnCostCents: number
  /// Market rent × vacant days, DOWN units excluded (review §12) - a unit
  /// off the market for repairs is not costing the owner a tenant it could
  /// not have rented anyway.
  vacancyLossCents: number
  /// What tenants actually agreed to pay for their occupied days (DOWN
  /// units excluded) - the "scheduled" side of economic occupancy.
  scheduledRentCents: number
  /// Value given away as move-in concessions (`Charge.type === 'CONCESSION'`),
  /// as a positive figure - added back on the economic-occupancy denominator
  /// because `incomeCents` above already nets it out.
  concessionCents: number
}

/// The Schedule E lines that are maintenance. Both, not just repairs: a
/// make-ready clean is maintenance spend on a house even though the form puts
/// it on line 7 and a leaking tap on line 14 (`workOrderExpenseLine`).
const MAINTENANCE_LINES = new Set([7, 14])

/**
 * The lemon view: one row per property, every number over the same window.
 *
 * Ordered worst net first, because the report exists to surface the property
 * losing money and a list sorted by name buries it.
 */
export function operatingSnapshot(input: {
  pandl: readonly PropertyPandL[]
  lines: readonly ExportLine[]
  unitCounts: ReadonlyMap<string, number>
  vacantDays: ReadonlyMap<string, number>
  availableDays: ReadonlyMap<string, number>
  ticketCounts: ReadonlyMap<string, number>
  turnCosts: ReadonlyMap<string, number>
  /// Optional: absent callers (all existing tests) get zero on the three new
  /// columns rather than having to thread empty maps through every case.
  vacancyLoss?: ReadonlyMap<string, number>
  scheduledRent?: ReadonlyMap<string, number>
  concessions?: ReadonlyMap<string, number>
}): PropertySnapshot[] {
  const maintenance = new Map<string, number>()
  for (const line of input.lines) {
    if (line.section !== 'EXPENSE') continue
    if (line.scheduleELine == null || !MAINTENANCE_LINES.has(line.scheduleELine)) continue
    maintenance.set(line.propertyId, (maintenance.get(line.propertyId) ?? 0) + line.amountCents)
  }

  return input.pandl
    .map((property) => ({
      propertyId: property.propertyId,
      propertyName: property.propertyName,
      unitCount: input.unitCounts.get(property.propertyId) ?? 0,
      incomeCents: property.incomeCents,
      maintenanceSpendCents: maintenance.get(property.propertyId) ?? 0,
      expenseCents: property.expenseCents,
      netCents: property.netCents,
      vacantDays: input.vacantDays.get(property.propertyId) ?? 0,
      availableDays: input.availableDays.get(property.propertyId) ?? 0,
      ticketCount: input.ticketCounts.get(property.propertyId) ?? 0,
      turnCostCents: input.turnCosts.get(property.propertyId) ?? 0,
      vacancyLossCents: input.vacancyLoss?.get(property.propertyId) ?? 0,
      scheduledRentCents: input.scheduledRent?.get(property.propertyId) ?? 0,
      concessionCents: input.concessions?.get(property.propertyId) ?? 0,
    }))
    .sort((a, b) => a.netCents - b.netCents || a.propertyName.localeCompare(b.propertyName))
}

/**
 * Collected ÷ (scheduled + vacancy loss + concessions) - the share of a
 * fully-let, no-concessions portfolio this property actually earned. Null
 * with nothing in the denominator, the same "not priced" reasoning
 * `dailyCostOfVacancyCents` uses - 0% would read as "earned nothing" rather
 * than "cannot be answered".
 */
export function economicOccupancy(facts: {
  collectedCents: number
  scheduledRentCents: number
  vacancyLossCents: number
  concessionCents: number
}): number | null {
  const denominator = facts.scheduledRentCents + facts.vacancyLossCents + facts.concessionCents
  if (denominator <= 0) return null
  return facts.collectedCents / denominator
}

/// Vacancy as a share of the days that could have been let. Null rather than
/// zero when nothing was available - a property acquired after the window
/// closed has no rate, and showing 0% would read as "never empty".
export function vacancyRate(facts: { vacantDays: number; availableDays: number }): number | null {
  if (facts.availableDays <= 0) return null
  return facts.vacantDays / facts.availableDays
}
