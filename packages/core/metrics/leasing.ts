// Renewal rate (LEASE-09, RPT-01, R-075) - extracted verbatim from
// apps/web/lib/dashboard/queries.ts's own inline loop, so the formula lives
// in one tested place instead of inside a query function.

export interface RenewalOutcome {
  status: string
  /// Whether a renewal successor lease exists. The caller's own Prisma
  /// query already limits this to `take: 1`; any non-empty list reads as
  /// "has one".
  renewalLeases: readonly { id: string }[]
}

export interface RenewalRate {
  renewed: number
  endedWithoutRenewal: number
  /// renewed / (renewed + endedWithoutRenewal), or 0 with nothing to divide.
  rate: number
}

/**
 * LEASE-09's "renewal rate is tracked as a metric".
 *
 * A structural snapshot of every ORIGINAL tenancy's outcome, not a
 * trailing-window rate - the caller excludes a renewal successor itself
 * from the input (`origin: { not: 'RENEWAL' }`), since its existence is the
 * OUTCOME being counted on the predecessor's own row, not a second original
 * tenancy. MONTH_TO_MONTH counts as "renewed" whatever put it there (an
 * automatic rollover job, or a lease started on MTM terms directly) - both
 * are a continuing tenancy, which is the number this metric is actually
 * asking about.
 */
export function renewalRate(leases: readonly RenewalOutcome[]): RenewalRate {
  let renewed = 0
  let endedWithoutRenewal = 0
  for (const lease of leases) {
    if (lease.status === 'MONTH_TO_MONTH' || lease.renewalLeases.length > 0) {
      renewed++
    } else {
      endedWithoutRenewal++
    }
  }
  const total = renewed + endedWithoutRenewal
  return { renewed, endedWithoutRenewal, rate: total > 0 ? renewed / total : 0 }
}
