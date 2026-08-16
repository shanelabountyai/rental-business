import { businessDaysBetween } from '../scheduling/local-time.ts'
import type { BusinessDate } from '../scheduling/local-time.ts'

// Days on market and the daily cost of sitting empty (RPT-01, R-050).
//
// NO NEW TIMESTAMP FIELD. `Lease.moveOutAt` is already recorded at the exact
// moment a unit stops earning rent - `leases/actions.ts` writes it the same
// transaction that flips the unit off OCCUPIED, and `auto-make-ready.ts`
// writes it for a lease that lapsed with no staff action at all. Inventing a
// second "vacant since" column on Unit would be a date that can drift from
// the one the rest of the product already treats as the moment occupancy
// ended - the exact class of bug this codebase keeps a running list of
// (adding a second copy of a fact instead of reading the first one).
//
// A unit with NO prior lease at all - never occupied since it was added -
// has no `moveOutAt` to read. Its own `createdAt` is the honest fallback:
// the day it entered the portfolio is the day it started "on the market" in
// every sense that matters to an owner deciding whether it is costing them
// money.

export interface VacancyFacts {
  /// The most recent lease's `moveOutAt`, when the unit has ever been
  /// leased. Null for a unit that has never had one.
  lastMoveOutAt: BusinessDate | null
  /// When the unit itself was added, for the fallback above.
  unitCreatedAt: BusinessDate
  asOf: BusinessDate
}

/// Days the unit has been sitting empty, counted from whichever date the
/// unit actually started being vacant from.
export function daysOnMarket(facts: VacancyFacts): number {
  const since = facts.lastMoveOutAt ?? facts.unitCreatedAt
  return Math.max(0, businessDaysBetween(since, facts.asOf))
}

/**
 * What one more day of vacancy costs, in cents.
 *
 * `marketRentCents / 30`, a flat thirty-day month rather than the calendar
 * month's real length. Precision to the day does not change what an owner
 * does with this number - it is a magnitude to weigh against a turn's cost,
 * not a ledger entry - and thirty is the number every "per-day rent" rule of
 * thumb in property management already uses, so it reads as the number an
 * owner expects rather than one that needs explaining.
 *
 * Null when there is no asking rent on file - a unit nobody has priced yet
 * has no honest daily figure to report, and zero would read as "costing
 * nothing" rather than "not priced".
 */
export function dailyCostOfVacancyCents(marketRentCents: number | null): number | null {
  if (marketRentCents == null) return null
  return Math.round(marketRentCents / 30)
}
