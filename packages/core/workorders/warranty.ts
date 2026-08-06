// Warranty surfacing before dispatch (PROP-06, MAINT-03, R-024).
//
// "Given a tracked asset with warranty, when the WO is created, then
// warranty status surfaces before dispatch." Every non-expired warranty on
// the property is shown - a PM reading provider and coverage is a better
// judge of what's covered than a category-matching heuristic would be - but
// one whose category lines up with the ticket's own category is flagged as
// the likely match, so the PM is not left to read every row with equal
// attention.
//
// The match is direct string equality only (HVAC ticket <-> HVAC warranty,
// APPLIANCE <-> APPLIANCE) - deliberately not fuzzy. A PLUMBING ticket about
// a water heater and a WATER_HEATER warranty are the same asset to a human
// and two different strings to this function; guessing that connection
// wrong would bury a real match under a false one, which is worse than not
// guessing at all.

export interface WarrantyLike {
  id: string
  category: string
  expiresOn: Date | null
}

/// now is passed in rather than read internally - see D-3's own reasoning
/// for the same pattern in packages/core/scheduling: a pure function should
/// not reach for the clock itself.
export function isWarrantyActive(warranty: WarrantyLike, now: Date): boolean {
  return warranty.expiresOn == null || warranty.expiresOn >= now
}

export function activeWarranties<T extends WarrantyLike>(
  warranties: readonly T[],
  now: Date,
): T[] {
  return warranties.filter((w) => isWarrantyActive(w, now))
}

/// Category the WORK ORDER is about, not necessarily the ticket's own
/// MAINTENANCE_CATEGORIES value - a standalone work order has no ticket and
/// therefore no category to match against, and that is fine: every active
/// warranty still shows, just with none flagged as the likely one.
export function likelyMatchingWarranty<T extends WarrantyLike>(
  category: string | null | undefined,
  warranties: readonly T[],
): T | null {
  if (!category) return null
  return warranties.find((w) => w.category === category) ?? null
}
