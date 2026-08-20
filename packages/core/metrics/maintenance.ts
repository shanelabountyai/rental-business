// Maintenance metrics beyond the SLA state classifier (MAINT-07, RPT-01,
// R-075). `firstResponseSlaState`/`ticketGlows` in `../maintenance/sla.ts`
// answer "where does this ONE ticket stand right now"; the functions below
// answer "how are we doing across many tickets", which needs a duration, not
// a state, and did not exist anywhere before this item.

const PRIORITIES = ['EMERGENCY', 'URGENT', 'ROUTINE'] as const
export type MaintenancePriority = (typeof PRIORITIES)[number]

/// Hours from a ticket's creation to its first staff response, or null while
/// still waiting. `firstResponseSlaState` classifies this same gap into
/// on_track/approaching/breached but never returns the number itself - a
/// state machine has no use for it, and an average across many tickets does.
export function firstResponseHours(ticket: {
  createdAt: Date
  firstResponseAt: Date | null
}): number | null {
  if (!ticket.firstResponseAt) return null
  return (ticket.firstResponseAt.getTime() - ticket.createdAt.getTime()) / 3_600_000
}

export interface ResolutionStats {
  count: number
  /// Average hours to close, or null when nothing in this priority has
  /// closed yet - zero would read as "closes instantly", a different, false
  /// claim.
  avgHours: number | null
}

/**
 * Time-to-resolve, bucketed by priority (RPT-01). Every priority is present
 * even at zero, the same "a report never silently omits a column" rule
 * `agingTotals` already keeps for delinquency buckets - a portfolio with no
 * EMERGENCY tickets this month should read as zero, not as an absent row.
 *
 * MEASURES THE TICKET'S OWN CLOCK (`createdAt` -> `closedAt`), not a work
 * order's - `sla.ts`'s own header already names the discipline of stating
 * which clock a maintenance metric reads, and a ticket can outlive several
 * work orders (a callback, a second visit) before it closes.
 */
export function resolutionByPriority(
  tickets: readonly { priority: string; createdAt: Date; closedAt: Date | null }[],
): Record<MaintenancePriority, ResolutionStats> {
  const totals = Object.fromEntries(
    PRIORITIES.map((p) => [p, { count: 0, totalHours: 0 }]),
  ) as Record<MaintenancePriority, { count: number; totalHours: number }>

  for (const ticket of tickets) {
    if (!ticket.closedAt) continue
    if (!(PRIORITIES as readonly string[]).includes(ticket.priority)) continue
    const bucket = totals[ticket.priority as MaintenancePriority]
    bucket.count += 1
    bucket.totalHours += (ticket.closedAt.getTime() - ticket.createdAt.getTime()) / 3_600_000
  }

  return Object.fromEntries(
    PRIORITIES.map((p) => [
      p,
      {
        count: totals[p].count,
        avgHours: totals[p].count > 0 ? totals[p].totalHours / totals[p].count : null,
      },
    ]),
  ) as Record<MaintenancePriority, ResolutionStats>
}

/**
 * Maintenance cost per unit per month, from a period's total job cost (the
 * caller sums `jobCostCents()`, `packages/core/workorders`, over the
 * period's closed jobs) and how many units and months the period spans.
 *
 * Division only, not aggregation - the sum is a plain `.reduce()` the
 * caller already has to do to build the total, and wrapping it in a core
 * function called from exactly one place would be the "config for a value
 * that never changes" shape this codebase avoids elsewhere, just for
 * arithmetic instead of a constant.
 */
export function costPerUnitPerMonth(facts: {
  totalCostCents: number
  unitCount: number
  months: number
}): number {
  if (facts.unitCount <= 0 || facts.months <= 0) return 0
  return facts.totalCostCents / facts.unitCount / facts.months
}
