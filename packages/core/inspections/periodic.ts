// The recurring half of the checklist engine (INSP-04, R-073): annual
// interior, seasonal exterior, and drive-by inspections happen on a
// calendar, not off a lease event - MOVE_IN/MOVE_OUT/PRE_MOVE_OUT stay
// lease-driven and never touch this file.

import type { BusinessDate } from '../scheduling/local-time.ts'

export const PERIODIC_TYPES = ['PERIODIC', 'SEASONAL', 'DRIVE_BY'] as const
export type PeriodicTypeValue = (typeof PERIODIC_TYPES)[number]

export function isPeriodicType(value: string): value is PeriodicTypeValue {
  return (PERIODIC_TYPES as readonly string[]).includes(value)
}

/// ponytail: a fixed cadence per type, not an owner-configurable number or a
/// JurisdictionRule fact - nothing in the PRD makes inspection frequency
/// statutory, so a literal is the honest placeholder. Promote to
/// Property/JurisdictionRule config if an owner ever needs a different
/// interval than this.
export const PERIODIC_INTERVAL_MONTHS: Readonly<Record<PeriodicTypeValue, number>> = {
  PERIODIC: 12,
  SEASONAL: 6,
  DRIVE_BY: 3,
}

/**
 * `lastPerformed` plus this type's interval, clamped to the target month's
 * real last day - `2024-02-29` plus a 12-month interval is `2025-02-28`, not
 * the naive Date-rollover result of `2025-03-01`.
 */
export function nextPeriodicDueDate(lastPerformed: BusinessDate, type: PeriodicTypeValue): BusinessDate {
  const [year, month, day] = lastPerformed.split('-').map(Number) as [number, number, number]
  const totalMonths = month - 1 + PERIODIC_INTERVAL_MONTHS[type]
  const targetYear = year + Math.floor(totalMonths / 12)
  const targetMonth = ((totalMonths % 12) + 12) % 12 // 0-11
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  const targetDay = Math.min(day, daysInTargetMonth)
  return new Date(Date.UTC(targetYear, targetMonth, targetDay)).toISOString().slice(0, 10)
}
