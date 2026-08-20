// Portfolio/property occupancy (RPT-01, R-075).
//
// PHYSICAL occupancy, not economic: a DOWN unit (long-term uninhabitable -
// fire damage, condemned) counts as NOT occupied here, the same as VACANT
// or MAKE_READY. "What fraction of doors have a tenant in them right now"
// is the question a dashboard tile named "Occupancy" answers first, and
// excluding DOWN units from the denominator (an "economic occupancy" that
// counts only rentable inventory) is a real, different number nobody has
// asked for yet - revisit if an owner wants that reading instead.

export interface OccupancyCounts {
  occupied: number
  total: number
}

/// occupied / total, or 0 with no units to report on - never NaN.
export function occupancyRate(counts: OccupancyCounts): number {
  if (counts.total <= 0) return 0
  return counts.occupied / counts.total
}
