import 'server-only'

import {
  type MaintenancePriority,
  type ReopenRate,
  type ResolutionStats,
  type VendorCost,
  costPerUnitPerMonth,
  reopenRate,
  repeatIssues,
  resolutionByPriority,
  vendorCosts,
} from '@rental/core/metrics'
import type { BusinessDate } from '@rental/core/scheduling'
import { jobCostCents } from '@rental/core/workorders'
import { vendorReopenRates } from '@rental/core/workorders'
import type { VendorPerformance } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Maintenance analytics (MAINT-10, R-081c). Fetch here, decide in
// `packages/core/metrics/maintenance.ts`.
//
// FOUR OF THESE FORMULAS ALREADY EXISTED AND HAD NO CALLER. R-075 wrote
// `resolutionByPriority` and `costPerUnitPerMonth` and named R-076/R-081a as
// their intended first callers; neither needed them. `WorkOrder.reopenedAt`
// and `reopenCount` have been written since R-030 and nothing read either.
// This item is where all of them land, which is why so little of it is new
// arithmetic.

export interface RepeatIssueRow {
  unitId: string
  unitName: string
  propertyName: string
  /// The property's zone. `firstAt`/`lastAt` are instants, and this report
  /// spans a portfolio, so the row has to carry its own clock.
  timezone: string
  category: string
  count: number
  firstAt: Date
  lastAt: Date
  ticketIds: string[]
}

export interface VendorRow {
  vendorId: string
  vendorName: string
  jobs: number
  totalCents: number
  averageCents: number
  /// From `vendorReopenRates`, which is keyed on the vendor captured when the
  /// TENANT ANSWERED, not on whoever holds the work order now. Null when this
  /// vendor has no answered verifications — see the report's own note on why
  /// the two halves of this row are attributed differently.
  performance: VendorPerformance | null
}

export interface MaintenanceAnalytics {
  from: BusinessDate
  to: BusinessDate
  resolution: Record<MaintenancePriority, ResolutionStats>
  repeats: RepeatIssueRow[]
  reopen: ReopenRate
  vendors: VendorRow[]
  totalCostCents: number
  unitCount: number
  months: number
  costPerUnitPerMonthCents: number
}

export async function maintenanceAnalytics(
  scope: ResolvedScope,
  from: BusinessDate,
  to: BusinessDate,
): Promise<MaintenanceAnalytics> {
  const propertyIds = scope.propertyIds
  const empty: MaintenanceAnalytics = {
    from,
    to,
    resolution: resolutionByPriority([]),
    repeats: [],
    reopen: reopenRate([]),
    vendors: [],
    totalCostCents: 0,
    unitCount: 0,
    months: 0,
    costPerUnitPerMonthCents: 0,
  }
  if (propertyIds.length === 0) return empty

  const windowStart = new Date(`${from}T00:00:00.000Z`)
  const windowEnd = new Date(`${to}T23:59:59.999Z`)

  const [tickets, jobs, unitCount] = await Promise.all([
    // A merged ticket is one complaint counted twice. Excluded here for the
    // same reason R-081a excludes it from ticket counts, and it matters more
    // in this report: two people reporting one leak would otherwise BE a
    // repeat issue, manufacturing the exact pattern the report hunts for.
    prisma.ticket.findMany({
      where: {
        propertyId: { in: propertyIds },
        mergedIntoTicketId: null,
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        id: true,
        unitId: true,
        category: true,
        priority: true,
        createdAt: true,
        closedAt: true,
        unit: {
          select: { name: true, property: { select: { name: true, timezone: true } } },
        },
      },
    }),
    // Closed inside the window, which is when a job's cost is knowable and
    // when it has had its chance to be reopened.
    prisma.workOrder.findMany({
      where: {
        propertyId: { in: propertyIds },
        closedAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        closedAt: true,
        reopenCount: true,
        actualLaborCents: true,
        actualMaterialsCents: true,
        invoiceCents: true,
        vendorId: true,
        vendor: { select: { name: true } },
      },
    }),
    prisma.unit.count({ where: { propertyId: { in: propertyIds } } }),
  ])

  const costed = jobs.map((job) => ({ vendorId: job.vendorId, costCents: jobCostCents(job) }))
  const totalCostCents = costed.reduce((total, job) => total + job.costCents, 0)

  const vendorNames = new Map(
    jobs.flatMap((job) => (job.vendorId && job.vendor ? [[job.vendorId, job.vendor.name] as const] : [])),
  )
  const costsByVendor: VendorCost[] = vendorCosts(costed)

  // One query for every vendor on the report, not one per vendor — the same
  // call R-081b's 1099 list makes, and for the same reason: this screen is
  // opened with the whole portfolio in scope.
  const verifications = await prisma.workOrderVerification.findMany({
    where: { vendorId: { in: costsByVendor.map((row) => row.vendorId) } },
    select: { vendorId: true, resolved: true, rating: true },
  })
  const performanceById = new Map(
    vendorReopenRates(verifications).map((row) => [row.vendorId, row]),
  )

  const unitLabels = new Map(
    tickets.map((ticket) => [
      ticket.unitId,
      {
        unitName: ticket.unit.name,
        propertyName: ticket.unit.property.name,
        timezone: ticket.unit.property.timezone,
      },
    ]),
  )

  // Months in the window, for cost-per-unit-per-month. Inclusive of both
  // ends: January to December is twelve months, not eleven.
  const months =
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) +
    1

  return {
    from,
    to,
    resolution: resolutionByPriority(tickets),
    repeats: repeatIssues(
      tickets.map((ticket) => ({
        ticketId: ticket.id,
        unitId: ticket.unitId,
        category: ticket.category,
        createdAt: ticket.createdAt,
      })),
    ).map((issue) => ({
      ...issue,
      unitName: unitLabels.get(issue.unitId)?.unitName ?? issue.unitId,
      propertyName: unitLabels.get(issue.unitId)?.propertyName ?? '',
      timezone: unitLabels.get(issue.unitId)?.timezone ?? 'UTC',
    })),
    reopen: reopenRate(jobs),
    vendors: costsByVendor.map((row) => ({
      vendorId: row.vendorId,
      vendorName: vendorNames.get(row.vendorId) ?? row.vendorId,
      jobs: row.jobs,
      totalCents: row.totalCents,
      averageCents: row.averageCents,
      performance: performanceById.get(row.vendorId) ?? null,
    })),
    totalCostCents,
    unitCount,
    months,
    costPerUnitPerMonthCents: Math.round(
      costPerUnitPerMonth({ totalCostCents, unitCount, months }),
    ),
  }
}
