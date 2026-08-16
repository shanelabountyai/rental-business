import 'server-only'

import { daysUntilExpiry, expiryWindow } from '@rental/core/leases'
import { OPEN_TICKET_STATUSES } from '@rental/core/comms'
import { OPEN_TICKET_GLOW_HOURS, ticketGlows } from '@rental/core/maintenance'
import { businessDate, businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
import { priorityRank } from '@rental/core/tasks'
import { dailyCostOfVacancyCents, daysOnMarket } from '@rental/core/units'
import { prisma } from '@rental/db'
import { filingCabinetAlertsDue } from '@/lib/filing-cabinet/queries.ts'
import { rentRoll } from '@/lib/payments/rent-roll.ts'
import { OPEN_STATUSES as OPEN_TASK_STATUSES } from '@/lib/tasks/queries.ts'
import type { ResolvedScope } from '@/lib/scope/types.ts'

// The owner's exception-first landing screen (RPT-01, RPT-04, R-050).
//
// ==========================================================================
// "NO DEAD-END NUMBERS" IS THE ROW'S OWN REQUIREMENT, AND IT DECIDED WHAT
// GOT BUILT.
//
// Of the seven tiles the backlog names, two had a real query behind them
// already (aged delinquency via R-044's `rentRoll()`, and the Task queue
// R-011/D-9 built for everything else). The other five had either a partial
// query with no age/priority grouping, or nothing at all. Rather than point
// a tile at a page that cannot actually show the filtered rows behind its
// number, every tile here was built out for real - see each function's own
// note for what it reuses and what is new.
//
// ONE EXCEPTION, NAMED RATHER THAN HIDDEN: "compliance items due ≤30 days"
// reads from `filingCabinetAlertsDue()`, which covers mortgage ARM/balloon
// dates and insurance renewals - not the statutory compliance calendar
// (permits, certificates, mandated inspections) the PRD's own R-077 is
// reserved for and which does not exist in this product yet. That function
// was written, tested and never called by anything until this tile. The
// dashboard's own label says "Renewals & alerts" rather than "Compliance",
// so it never claims coverage it does not have.
// ==========================================================================

export interface DashboardSummary {
  collectedVsBilled: CollectedVsBilled
  delinquency: DelinquencySummary
  tickets: TicketSummary
  vacancies: VacancySummary
  leaseExpiry: LeaseExpirySummary
  pendingApprovals: PendingApprovalsSummary
  renewalAlerts: RenewalAlertsSummary
}

// ---- 1. Collected vs billed ----

export interface CollectedVsBilled {
  billedCents: number
  collectedCents: number
  periodLabel: string
}

/**
 * This calendar month's billed rent against what has actually settled.
 *
 * BILLED IS THE ACTIVE-LEASE TOTAL, NOT A SUM OF Charge ROWS. D-11/D-40 mint
 * no monthly `Charge` for the subscription's own rent line - R-044 and
 * R-045 both hit this and read the same way: what a portfolio is billing
 * this month is the sum of `rentCents` across every lease in force, not a
 * row that does not exist.
 *
 * COLLECTED IS SETTLED PAYMENTS RECEIVED THIS MONTH, PROPERTY-LOCAL (D-3).
 * "This month" is a different calendar day in a portfolio spanning
 * timezones, so the boundary is computed per property and the totals summed
 * - the same shape `rentRoll()` uses for "today".
 */
export async function collectedVsBilled(
  scope: ResolvedScope,
  asOf: Date,
): Promise<CollectedVsBilled> {
  if (scope.propertyIds.length === 0) {
    return { billedCents: 0, collectedCents: 0, periodLabel: '' }
  }

  const properties = await prisma.property.findMany({
    where: { id: { in: scope.propertyIds } },
    select: { id: true, timezone: true },
  })

  const leases = await prisma.lease.findMany({
    where: { propertyId: { in: scope.propertyIds }, status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
    select: { rentCents: true },
  })
  const billedCents = leases.reduce((sum, lease) => sum + lease.rentCents, 0)

  let collectedCents = 0
  let periodLabel = ''
  for (const property of properties) {
    const today = businessDate(asOf, property.timezone)
    const [year, month] = today.split('-')
    const monthStart = businessDateToUtc(`${year}-${month}-01`)
    if (!periodLabel) {
      periodLabel = new Date(`${year}-${month}-01T00:00:00.000Z`).toLocaleString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    }

    const settled = await prisma.payment.aggregate({
      where: {
        propertyId: property.id,
        status: 'SETTLED',
        receivedAt: { gte: monthStart, lte: asOf },
      },
      _sum: { amountCents: true },
    })
    collectedCents += settled._sum.amountCents ?? 0
  }

  return { billedCents, collectedCents, periodLabel }
}

// ---- 2. Aged delinquency — reuses R-044's rentRoll() wholesale ----

export interface DelinquencySummary {
  outstandingCents: number
  pastGraceCount: number
}

export async function delinquencySummary(
  scope: ResolvedScope,
  asOf: Date,
): Promise<DelinquencySummary> {
  // Deferred to the module R-044 already built and proved, rather than a
  // second aging pass here - see that item's own note on why "which bucket"
  // and "past grace" must never be computed twice.
  const roll = await rentRoll(scope, asOf)
  return {
    outstandingCents: roll.outstandingCents,
    pastGraceCount: roll.rows.filter((row) => row.pastGrace).length,
  }
}

// ---- 3. Open tickets by priority and age ----

export interface TicketSummary {
  openCount: number
  glowingCount: number
}

/**
 * How many open tickets, and how many are glowing (RPT-01: "emergency/urgent
 * >48h glow red").
 *
 * `ticketGlows()` is a DIFFERENT CLOCK from R-023's first-response SLA - see
 * that function's own note. This counts every open ticket regardless of
 * whether anybody has responded; the dashboard's question is "how much is
 * still sitting open", not "did we say hello yet".
 */
export async function ticketSummary(scope: ResolvedScope, asOf: Date): Promise<TicketSummary> {
  if (scope.propertyIds.length === 0) return { openCount: 0, glowingCount: 0 }

  const tickets = await prisma.ticket.findMany({
    where: {
      propertyId: { in: scope.propertyIds },
      // The SAME open set R-021's own SMS threading uses, not a second
      // hand-picked list - a status added there and missed here would
      // undercount every open-tickets number on the dashboard silently.
      status: { in: [...OPEN_TICKET_STATUSES] },
    },
    select: { priority: true, createdAt: true },
  })

  return {
    openCount: tickets.length,
    glowingCount: tickets.filter((ticket) => ticketGlows(ticket, asOf)).length,
  }
}

// ---- 4. Vacancies ----

export interface VacancySummary {
  count: number
  totalDailyCostCents: number
  /// The single oldest vacancy, for "how long has our worst one been
  /// sitting" - a count alone hides whether it is five units at three days
  /// each or one unit at ninety.
  longestDaysOnMarket: number
}

export interface VacantUnit {
  id: string
  name: string
  propertyId: string
  propertyName: string
  daysOnMarket: number
  dailyCostCents: number | null
}

/// The rows behind the vacancies tile, for its drill-down (R-050). The tile
/// itself is a fold over these same rows - see `vacancySummary` below - so
/// the two can never disagree the way a second hand-rolled query could.
export async function vacantUnits(scope: ResolvedScope, asOf: Date): Promise<VacantUnit[]> {
  if (scope.propertyIds.length === 0) return []

  const units = await prisma.unit.findMany({
    where: { propertyId: { in: scope.propertyIds }, status: { in: ['VACANT', 'MAKE_READY'] } },
    select: {
      id: true,
      name: true,
      marketRentCents: true,
      createdAt: true,
      property: { select: { id: true, name: true, timezone: true } },
      leases: {
        where: { moveOutAt: { not: null } },
        orderBy: { moveOutAt: 'desc' },
        take: 1,
        select: { moveOutAt: true },
      },
    },
  })

  return units.map((unit) => {
    const zone = unit.property.timezone
    return {
      id: unit.id,
      name: unit.name,
      propertyId: unit.property.id,
      propertyName: unit.property.name,
      daysOnMarket: daysOnMarket({
        lastMoveOutAt: unit.leases[0]?.moveOutAt ? utcToBusinessDate(unit.leases[0].moveOutAt) : null,
        unitCreatedAt: businessDate(unit.createdAt, zone),
        asOf: businessDate(asOf, zone),
      }),
      dailyCostCents: dailyCostOfVacancyCents(unit.marketRentCents),
    }
  })
}

export async function vacancySummary(scope: ResolvedScope, asOf: Date): Promise<VacancySummary> {
  const units = await vacantUnits(scope, asOf)
  return {
    count: units.length,
    totalDailyCostCents: units.reduce((sum, u) => sum + (u.dailyCostCents ?? 0), 0),
    longestDaysOnMarket: units.reduce((max, u) => Math.max(max, u.daysOnMarket), 0),
  }
}

// ---- 5. Leases expiring soon ----

export interface LeaseExpirySummary {
  within90: number
  within120: number
}

export async function leaseExpirySummary(
  scope: ResolvedScope,
  asOf: Date,
): Promise<LeaseExpirySummary> {
  if (scope.propertyIds.length === 0) return { within90: 0, within120: 0 }

  const leases = await prisma.lease.findMany({
    where: {
      propertyId: { in: scope.propertyIds },
      status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] },
      endsOn: { not: null },
    },
    select: { endsOn: true, property: { select: { timezone: true } } },
  })

  let within90 = 0
  let within120 = 0
  for (const lease of leases) {
    const zone = lease.property.timezone
    const days = daysUntilExpiry(
      lease.endsOn ? utcToBusinessDate(lease.endsOn) : null,
      businessDate(asOf, zone),
    )
    const window = expiryWindow(days)
    if (window === 90) within90 += 1
    if (window === 90 || window === 120) within120 += 1
  }

  return { within90, within120 }
}

// ---- 6. Pending approvals ----

export interface PendingApprovalsSummary {
  count: number
}

/**
 * Work-order approvals waiting on a decision (D-9, R-050).
 *
 * `myDayTasks()` - the dashboard's own work queue - deliberately excludes a
 * future-dated task and scopes to the current actor or unclaimed, because
 * its job is "what should I do today". A pending approval is neither: it is
 * urgent regardless of who it is assigned to and regardless of its
 * `businessDate`, so this reads Task directly rather than reusing that
 * query for a question it was not built to answer.
 */
export async function pendingApprovalsSummary(
  scope: ResolvedScope,
): Promise<PendingApprovalsSummary> {
  if (scope.propertyIds.length === 0) return { count: 0 }
  const count = await prisma.task.count({
    where: {
      propertyId: { in: scope.propertyIds },
      type: 'workorder_approval',
      status: { in: [...OPEN_TASK_STATUSES] },
    },
  })
  return { count }
}

// ---- 7. Renewals & alerts (the honest scope of "compliance", see header) ----

export interface RenewalAlertsSummary {
  count: number
}

export async function renewalAlertsSummary(
  scope: ResolvedScope,
  asOf: Date,
): Promise<RenewalAlertsSummary> {
  const alerts = await filingCabinetAlertsDue(scope, asOf)
  return { count: alerts.length }
}

// ---- All seven, one call ----

export async function dashboardSummary(
  scope: ResolvedScope,
  asOf: Date,
): Promise<DashboardSummary> {
  const [
    collected,
    delinquency,
    tickets,
    vacancies,
    leaseExpiry,
    pendingApprovals,
    renewalAlerts,
  ] = await Promise.all([
    collectedVsBilled(scope, asOf),
    delinquencySummary(scope, asOf),
    ticketSummary(scope, asOf),
    vacancySummary(scope, asOf),
    leaseExpirySummary(scope, asOf),
    pendingApprovalsSummary(scope),
    renewalAlertsSummary(scope, asOf),
  ])

  return {
    collectedVsBilled: collected,
    delinquency,
    tickets,
    vacancies,
    leaseExpiry,
    pendingApprovals,
    renewalAlerts,
  }
}

export { OPEN_TICKET_GLOW_HOURS, priorityRank }
