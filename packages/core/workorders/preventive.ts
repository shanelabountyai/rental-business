// Recurrence for a preventive-maintenance template (MAINT-08, R-080).
//
// SAME CLAMPED-MONTH-ROLLOVER ALGORITHM AS `nextPeriodicDueDate()`
// (`packages/core/inspections/periodic.ts`, R-073) and `nextComplianceDueDate()`
// (`packages/core/compliance/schedule.ts`, R-077), generalized to take the
// interval as a parameter - deliberately a THIRD separate small function,
// not those two imported and reused across domains. D-65/D-67 already made
// this call twice: moving or force-sharing an already-correct, already-tested
// ten-line function across domains is churn with a real regression risk, not
// a fix, for code this size.

import type { BusinessDate } from '../scheduling/local-time.ts'

/**
 * `lastPerformed` plus `intervalMonths`, clamped to the target month's real
 * last day - anchored to when the task was ACTUALLY last done, not a fixed
 * calendar slot, the same posture the other two `next*DueDate()` functions
 * already take.
 */
export function nextPreventiveDueDate(lastPerformed: BusinessDate, intervalMonths: number): BusinessDate {
  const [year, month, day] = lastPerformed.split('-').map(Number) as [number, number, number]
  const totalMonths = month - 1 + intervalMonths
  const targetYear = year + Math.floor(totalMonths / 12)
  const targetMonth = ((totalMonths % 12) + 12) % 12
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  const targetDay = Math.min(day, daysInTargetMonth)
  return new Date(Date.UTC(targetYear, targetMonth, targetDay)).toISOString().slice(0, 10)
}
