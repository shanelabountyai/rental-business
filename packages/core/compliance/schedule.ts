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

import type { BusinessDate } from '../scheduling/local-time.ts'

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
