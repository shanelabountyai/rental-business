// Recurrence for a compliance item (PROP-05, R-077).
//
// SAME CLAMPED-MONTH-ROLLOVER ALGORITHM AS `nextPeriodicDueDate()`
// (`packages/core/inspections/periodic.ts`, R-073), generalized to take the
// interval as a parameter instead of a type-keyed lookup - deliberately a
// SEPARATE small function, not that one imported and reused across
// domains. D-65 already made this call for `packages/core/metrics`: moving
// or force-sharing an already-correct, already-tested function across
// domains for a slightly different caller is churn with a real regression
// risk, for a ten-line function, not a fix.

import { type BusinessDate, businessDate } from '../scheduling/local-time.ts'

/**
 * `completedOn` plus `recurrenceMonths`, clamped to the target month's real
 * last day - anchored to when the obligation was ACTUALLY last satisfied,
 * not a fixed calendar slot, the same posture `nextPeriodicDueDate()`
 * already takes for inspections.
 */
export function nextComplianceDueDate(completedOn: BusinessDate, recurrenceMonths: number): BusinessDate {
  const [year, month, day] = completedOn.split('-').map(Number) as [number, number, number]
  const totalMonths = month - 1 + recurrenceMonths
  const targetYear = year + Math.floor(totalMonths / 12)
  const targetMonth = ((totalMonths % 12) + 12) % 12
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  const targetDay = Math.min(day, daysInTargetMonth)
  return new Date(Date.UTC(targetYear, targetMonth, targetDay)).toISOString().slice(0, 10)
}

/**
 * The calendar day an obligation is judged late against.
 *
 * "Overdue" compares two calendar days, so it needs a clock - and on a
 * portfolio list the clock belongs to the ROW, not to the request. A UTC
 * "today" reads overdue from around 18:00 local on every property west of
 * UTC. A property-level item takes its own property's zone; an entity-level
 * filing has no single property, so it takes the EARLIEST local day across
 * the entity's properties - late everywhere before it is called late.
 *
 * Returns null for an item with no property behind it at all, which is a
 * clock we do not have rather than a day that has arrived.
 */
export function complianceToday(now: Date, timezones: readonly string[]): BusinessDate | null {
  const days = timezones.map((zone) => businessDate(now, zone)).sort()
  return days[0] ?? null
}
