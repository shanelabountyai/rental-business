import 'server-only'

import { businessDate, businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
import { TURNOVER_STAGES, type TurnoverStageValue } from '@rental/core/turnover'
import { jobCostCents } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import { filingCabinetAlertsDue } from '@/lib/filing-cabinet/queries.ts'
import { vacantUnits, type VacantUnit } from '@/lib/dashboard/queries.ts'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for the five weekly operating reports (RPT-04, R-076).
//
// DELIBERATELY NOT A NEW METRICS MODULE. R-050 already built a real,
// tested query behind every portfolio-wide number the dashboard shows
// (`apps/web/lib/dashboard/queries.ts`), and R-075 gave the remaining
// formulas one tested home each (`@rental/core/metrics`). This file is
// where those get GROUPED and UNIONED the way a weekly report actually
// reads - per entity, across several date sources - not a second copy of
// arithmetic that already exists.

const CRITICAL_DATE_WINDOW_DAYS = 60
const DAY_MS = 24 * 60 * 60 * 1_000

// ---------------------------------------------------------------------------
// Report 4: cash summary per entity
// ---------------------------------------------------------------------------

export interface EntityCashSummary {
  legalEntityId: string
  legalEntityName: string
  billedCents: number
  collectedCents: number
  periodLabel: string
  /// Largest closed job costs this period - "big outflows" (RPT-04's own
  /// wording), capped at 5 so this stays a summary, not a second ledger.
  bigOutflows: { workOrderId: string; description: string; costCents: number }[]
}

/**
 * Collected vs billed, grouped by legal entity rather than summed across
 * the whole scope - `collectedVsBilled()` (R-050) already proves the
 * per-property month-boundary arithmetic this reuses the SAME shape of,
 * just bucketed differently, since an owner reading this report cares
 * which entity a shortfall sits in, not only the portfolio total.
 *
 * NO RESERVE-VS-TARGET YET. Nothing in this product tracks a configured
 * reserve target anywhere (R-082 owns building that); showing one here
 * would be inventing a number nobody set; see the page's own note.
 */
export async function cashSummaryByEntity(
  scope: ResolvedScope,
  asOf: Date,
): Promise<EntityCashSummary[]> {
  if (scope.propertyIds.length === 0) return []

  const properties = await prisma.property.findMany({
    where: { id: { in: scope.propertyIds } },
    select: { id: true, timezone: true, legalEntityId: true, legalEntity: { select: { name: true } } },
  })

  const byEntity = new Map<string, { name: string; propertyIds: string[]; timezone: string }>()
  for (const property of properties) {
    const entry = byEntity.get(property.legalEntityId) ?? {
      name: property.legalEntity.name,
      propertyIds: [],
      timezone: property.timezone,
    }
    entry.propertyIds.push(property.id)
    byEntity.set(property.legalEntityId, entry)
  }

  const summaries: EntityCashSummary[] = []
  for (const [legalEntityId, info] of byEntity) {
    const leases = await prisma.lease.findMany({
      where: { propertyId: { in: info.propertyIds }, status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
      select: { rentCents: true },
    })
    const billedCents = leases.reduce((sum, lease) => sum + lease.rentCents, 0)

    // Same month-boundary shape `collectedVsBilled()` uses: property-local
    // "this month" (D-3), one entity's properties can span timezones.
    const today = businessDate(asOf, info.timezone)
    const [year, month] = today.split('-')
    const monthStart = businessDateToUtc(`${year}-${month}-01`)
    const periodLabel = new Date(`${year}-${month}-01T00:00:00.000Z`).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })

    const settled = await prisma.payment.aggregate({
      where: {
        propertyId: { in: info.propertyIds },
        status: 'SETTLED',
        receivedAt: { gte: monthStart, lte: asOf },
      },
      _sum: { amountCents: true },
    })

    const closedWorkOrders = await prisma.workOrder.findMany({
      where: { propertyId: { in: info.propertyIds }, status: 'CLOSED', updatedAt: { gte: monthStart, lte: asOf } },
      select: { id: true, scope: true, actualLaborCents: true, actualMaterialsCents: true, invoiceCents: true },
    })
    const bigOutflows = closedWorkOrders
      .map((wo) => ({ workOrderId: wo.id, description: wo.scope, costCents: jobCostCents(wo) }))
      .sort((a, b) => b.costCents - a.costCents)
      .slice(0, 5)

    summaries.push({
      legalEntityId,
      legalEntityName: info.name,
      billedCents,
      collectedCents: settled._sum.amountCents ?? 0,
      periodLabel,
      bigOutflows,
    })
  }

  return summaries.sort((a, b) => a.legalEntityName.localeCompare(b.legalEntityName))
}

// ---------------------------------------------------------------------------
// Report 5: upcoming critical dates, next 60 days
// ---------------------------------------------------------------------------

export type CriticalDateKind =
  | 'LEASE_EXPIRATION'
  | 'ARM_ADJUSTMENT'
  | 'BALLOON_MATURITY'
  | 'INSURANCE_RENEWAL'
  | 'RENTER_INSURANCE_EXPIRING'
  | 'DEPOSIT_DISPOSITION_DUE'

export interface CriticalDate {
  propertyId: string
  propertyName: string
  kind: CriticalDateKind
  dueOn: Date
  label: string
}

/**
 * The union RPT-04 names: "lease expirations, compliance, insurance
 * renewals, COI expiries, deposit-return clocks" - minus statutory
 * compliance, which is R-077's own item and does not exist in this product
 * yet (the same honest gap R-050's "Renewals & alerts" tile already names
 * rather than overclaiming). Every source already has its own tested
 * definition (`filingCabinetAlertsDue`, R-015; `Deposit.dispositionDueOn`,
 * R-071) - this only unions and re-filters them to one 60-day window,
 * since each source's own internal alert window differs (mortgage ARM and
 * insurance are already 60 days; balloon maturity is 180, so a real
 * upcoming balloon 90 days out would otherwise be silently excluded from a
 * REPORT whose own name promises "next 60 days" and included here only if
 * inside it).
 */
export async function upcomingCriticalDates(
  scope: ResolvedScope,
  asOf: Date,
): Promise<CriticalDate[]> {
  if (scope.propertyIds.length === 0) return []
  // Every source compared below is a `@db.Date` column - UTC midnight,
  // never a real instant (CLAUDE.md's own warning on this column type).
  // Comparing against the raw `asOf` instant would exclude anything due
  // LATER TODAY, since today's own UTC midnight is already behind the
  // current time of day - so the window starts at today's own UTC
  // midnight, not this instant.
  const todayUtc = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()))
  const cutoff = new Date(todayUtc.getTime() + CRITICAL_DATE_WINDOW_DAYS * DAY_MS)

  const properties = await prisma.property.findMany({
    where: { id: { in: scope.propertyIds } },
    select: { id: true, name: true },
  })
  const propertyName = new Map(properties.map((p) => [p.id, p.name]))

  const dates: CriticalDate[] = []

  const leases = await prisma.lease.findMany({
    where: {
      propertyId: { in: scope.propertyIds },
      status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] },
      endsOn: { not: null, gte: todayUtc, lte: cutoff },
    },
    select: { propertyId: true, endsOn: true, unit: { select: { name: true } } },
  })
  for (const lease of leases) {
    dates.push({
      propertyId: lease.propertyId,
      propertyName: propertyName.get(lease.propertyId) ?? '',
      kind: 'LEASE_EXPIRATION',
      dueOn: lease.endsOn!,
      label: `Lease ends — ${lease.unit.name}`,
    })
  }

  const filingAlerts = await filingCabinetAlertsDue(scope, asOf)
  for (const alert of filingAlerts) {
    if (alert.dueOn.getTime() > cutoff.getTime()) continue
    dates.push({
      propertyId: alert.propertyId,
      propertyName: propertyName.get(alert.propertyId) ?? '',
      kind: alert.kind,
      dueOn: alert.dueOn,
      label:
        alert.kind === 'ARM_ADJUSTMENT'
          ? 'Mortgage ARM adjustment'
          : alert.kind === 'BALLOON_MATURITY'
            ? 'Mortgage balloon maturity'
            : `Insurance renewal${alert.insurancePolicy ? ` — ${alert.insurancePolicy.carrier}` : ''}`,
    })
  }

  const renterPolicies = await prisma.renterInsurancePolicy.findMany({
    where: {
      lease: { propertyId: { in: scope.propertyIds }, status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
      expiresOn: { not: null, gte: todayUtc, lte: cutoff },
    },
    orderBy: { createdAt: 'desc' },
    select: { expiresOn: true, lease: { select: { propertyId: true, unit: { select: { name: true } } } } },
  })
  const seenLease = new Set<string>()
  for (const policy of renterPolicies) {
    // Most-recent policy per lease only - an older, already-superseded
    // certificate for the same tenancy is not a real upcoming date.
    const key = `${policy.lease.propertyId}:${policy.lease.unit.name}`
    if (seenLease.has(key)) continue
    seenLease.add(key)
    dates.push({
      propertyId: policy.lease.propertyId,
      propertyName: propertyName.get(policy.lease.propertyId) ?? '',
      kind: 'RENTER_INSURANCE_EXPIRING',
      dueOn: policy.expiresOn!,
      label: `Renter's insurance expires — ${policy.lease.unit.name}`,
    })
  }

  const deposits = await prisma.deposit.findMany({
    where: {
      propertyId: { in: scope.propertyIds },
      dispositionDueOn: { not: null, gte: todayUtc, lte: cutoff },
      dispositionSentAt: null,
    },
    select: { propertyId: true, dispositionDueOn: true, lease: { select: { unit: { select: { name: true } } } } },
  })
  for (const deposit of deposits) {
    dates.push({
      propertyId: deposit.propertyId,
      propertyName: propertyName.get(deposit.propertyId) ?? '',
      kind: 'DEPOSIT_DISPOSITION_DUE',
      dueOn: deposit.dispositionDueOn!,
      label: `Deposit disposition due — ${deposit.lease.unit.name}`,
    })
  }

  return dates.sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime())
}

// ---------------------------------------------------------------------------
// Report 3: vacancy & turn status
// ---------------------------------------------------------------------------

export interface VacantUnitWithTurnover extends VacantUnit {
  targetRentReadyDate: string | null
  /// The earliest-in-sequence stage still open on this turn's own work
  /// orders (`TURNOVER_STAGES`' own display order) - "currently being
  /// worked on", not a status this project tracks as a column of its own
  /// (`TurnoverProject`'s own schema comment: null/set on `rentReadyAt` IS
  /// the status). Null means no turnover project on file yet for this
  /// vacancy, or every one of its work orders is already done.
  currentStage: string | null
}

const NOT_DONE_STATUSES = new Set(['CLOSED', 'CANCELED', 'INVOICED'])

export function currentStageFor(
  workOrders: readonly { turnoverStage: string | null; status: string }[],
): TurnoverStageValue | null {
  const openStages = new Set(
    workOrders
      .filter((wo) => wo.turnoverStage && !NOT_DONE_STATUSES.has(wo.status))
      .map((wo) => wo.turnoverStage as TurnoverStageValue),
  )
  return TURNOVER_STAGES.find((stage) => openStages.has(stage)) ?? null
}

/// `vacantUnits()` (R-050) plus each unit's own turnover project, if any -
/// the target rent-ready date and which stage is currently open.
export async function vacantUnitsWithTurnover(
  scope: ResolvedScope,
  asOf: Date,
): Promise<VacantUnitWithTurnover[]> {
  const units = await vacantUnits(scope, asOf)
  if (units.length === 0) return []

  const projects = await prisma.turnoverProject.findMany({
    where: { unitId: { in: units.map((u) => u.id) }, rentReadyAt: null },
    select: {
      unitId: true,
      targetRentReadyDate: true,
      workOrders: { select: { turnoverStage: true, status: true } },
    },
  })
  const projectByUnit = new Map(projects.map((p) => [p.unitId, p]))

  return units.map((unit) => {
    const project = projectByUnit.get(unit.id)
    return {
      ...unit,
      targetRentReadyDate: project?.targetRentReadyDate ? utcToBusinessDate(project.targetRentReadyDate) : null,
      currentStage: project ? currentStageFor(project.workOrders) : null,
    }
  })
}

export interface WeeklyLeasingActivity {
  newLeads: number
  showingsScheduled: number
  applicationsStarted: number
}

/// Leads, showings and applications from the last 7 days, portfolio-wide -
/// RPT-04's own "this week" framing for the vacancy/turn report, read
/// directly rather than through a metrics abstraction nothing else needs
/// (three plain counts, not a formula).
export async function thisWeekLeasingActivity(
  scope: ResolvedScope,
  asOf: Date,
): Promise<WeeklyLeasingActivity> {
  if (scope.propertyIds.length === 0) {
    return { newLeads: 0, showingsScheduled: 0, applicationsStarted: 0 }
  }
  const weekAgo = new Date(asOf.getTime() - 7 * DAY_MS)

  const [newLeads, showingsScheduled, applicationsStarted] = await Promise.all([
    prisma.prospect.count({
      where: { propertyId: { in: scope.propertyIds }, createdAt: { gte: weekAgo, lte: asOf } },
    }),
    prisma.showing.count({
      where: {
        propertyId: { in: scope.propertyIds },
        scheduledStart: { gte: weekAgo, lte: asOf },
        canceledAt: null,
      },
    }),
    prisma.application.count({
      where: { propertyId: { in: scope.propertyIds }, createdAt: { gte: weekAgo, lte: asOf } },
    }),
  ])

  return { newLeads, showingsScheduled, applicationsStarted }
}
