import { businessDaysBetween } from '../scheduling/local-time.ts'
import type { BusinessDate } from '../scheduling/local-time.ts'

// Leases expiring soon (RPT-01, R-050).
//
// A MONTH-TO-MONTH LEASE NEVER EXPIRES, and that is not an edge case to
// special-case here - it is the whole reason `endsOn` is nullable on a
// month-to-month row in the first place (LEASE-09's rollover clears the term
// date rather than leaving a stale one behind). A caller passing a null
// `endsOn` gets `null` back, meaning "not applicable", not "expires never" -
// the dashboard tile counts leases genuinely approaching a term, and a
// rolling tenancy is not one.

export const EXPIRY_WINDOWS = [90, 120] as const
export type ExpiryWindow = (typeof EXPIRY_WINDOWS)[number]

/// Days until the lease's term ends, or null when it has none (month-to-
/// month, or already ended). Negative for a term date already past - a lease
/// somebody forgot to roll over or close out, which is itself worth
/// surfacing rather than silently dropping from the count.
export function daysUntilExpiry(endsOn: BusinessDate | null, asOf: BusinessDate): number | null {
  if (!endsOn) return null
  return businessDaysBetween(asOf, endsOn)
}

/// The narrowest named window a lease's expiry falls inside, for grouping on
/// the dashboard. `null` covers both "no term date" and "further out than
/// 120 days" - the tile does not care which, it only wants "not yet urgent".
export function expiryWindow(daysUntil: number | null): ExpiryWindow | null {
  if (daysUntil == null) return null
  for (const window of EXPIRY_WINDOWS) {
    if (daysUntil <= window) return window
  }
  return null
}
