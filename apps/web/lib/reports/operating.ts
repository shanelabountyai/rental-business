import 'server-only'

import {
  type PropertyPandL,
  type PropertySnapshot,
  type TradeSpend,
  availableFrom,
  monthlyPandL,
  operatingSnapshot,
  renewalRate,
  scheduledRentCentsInWindow,
  spendByTrade,
  tradeForJob,
  vacantDaysInWindow,
} from '@rental/core/metrics'
import type { OccupiedInterval, RentedInterval, RenewalRate } from '@rental/core/metrics'
import { businessDate, businessDaysBetween, utcToBusinessDate } from '@rental/core/scheduling'
import type { BusinessDate } from '@rental/core/scheduling'
import type { AccountingBasis, ExportLine } from '@rental/core/tax'
import { dailyCostOfVacancyCents } from '@rental/core/units'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import { taxExportFacts } from '@/lib/tax/queries.ts'

// The per-property operating report (RPT-05, R-081a).
//
// ===========================================================================
// THE INCOME AND EXPENSE NUMBERS ARE R-078'S, RE-GROUPED - NOT RE-FETCHED.
//
// `taxExportFacts` already returns per-property, Schedule-E-classified lines
// carrying a `BusinessDate`, and it is the only place that knows the ledger
// sign-flip rule, the capitalised-job exclusion and the read-the-timestamp-in-
// the-property's-zone rule. A second income/expense pipeline here would be a
// second copy of all three, and all three are silent when wrong.
//
// Spend-by-trade is derived from those same lines rather than from its own
// work-order query, so the trade columns cannot disagree with the expense
// total printed above them on the same page.
// ===========================================================================

export interface OperatingReport {
  legalEntityId: string
  legalEntityName: string
  year: number
  basis: AccountingBasis
  from: BusinessDate
  to: BusinessDate
  snapshot: PropertySnapshot[]
  pandl: PropertyPandL[]
  tradeSpend: TradeSpend[]
  renewal: RenewalRate
  /// Carried through from the export. A report that quietly dropped what it
  /// could not classify would be a report somebody acts on (R-078's rule).
  unmappedCount: number
  unmappedCents: number
}

/**
 * Physical occupancy, preferring what actually happened over what was agreed.
 *
 * `moveInAt`/`moveOutAt` are real TIMESTAMPS and read through the property's
 * zone; `startsOn`/`endsOn` are `@db.Date` calendar days that no zone may
 * touch. Mixing the two readers up is the R-042 defect, and here it would
 * shift a turn across a month boundary and move vacancy days between two
 * reporting periods.
 *
 * The fallback matters in ordinary use, not just in theory: a lease can be
 * ACTIVE with no `moveInAt` recorded, and treating that unit as empty all
 * year would put a fully-let house at the top of the lemon list.
 */
function occupiedInterval(
  lease: {
    startsOn: Date
    endsOn: Date | null
    moveInAt: Date | null
    moveOutAt: Date | null
  },
  zone: string,
): OccupiedInterval {
  return {
    movedInOn:
      lease.moveInAt != null ? businessDate(lease.moveInAt, zone) : utcToBusinessDate(lease.startsOn),
    movedOutOn:
      lease.moveOutAt != null
        ? businessDate(lease.moveOutAt, zone)
        : lease.endsOn != null
          ? utcToBusinessDate(lease.endsOn)
          : null,
  }
}

export async function operatingReport(
  scope: ResolvedScope,
  legalEntityId: string,
  year: number,
  basis: AccountingBasis,
): Promise<OperatingReport | null> {
  const report = await taxExportFacts(scope, legalEntityId, year, basis)
  if (!report) return null

  const propertyIds = scope.availableProperties
    .filter((p) => p.legalEntityId === legalEntityId && scope.propertyIds.includes(p.id))
    .map((p) => p.id)

  const from: BusinessDate = `${year}-01-01`
  const to: BusinessDate = `${year}-12-31`
  const windowStart = new Date(Date.UTC(year, 0, 1))
  const windowEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999))

  const workOrderIds = report.lines
    .filter((line) => line.sourceKind === 'WorkOrder')
    .map((line) => line.sourceId)

  const [properties, units, ticketCounts, jobTrades, renewalLeases, concessionCharges] = await Promise.all([
    prisma.property.findMany({
      where: { id: { in: propertyIds } },
      select: {
        id: true,
        name: true,
        timezone: true,
        acquiredOn: true,
        createdAt: true,
        historyStartsOn: true,
      },
    }),
    prisma.unit.findMany({
      where: { propertyId: { in: propertyIds } },
      select: {
        id: true,
        propertyId: true,
        status: true,
        marketRentCents: true,
        leases: {
          select: { startsOn: true, endsOn: true, moveInAt: true, moveOutAt: true, rentCents: true },
        },
      },
    }),
    // A merged ticket is the same complaint counted twice - excluded, or the
    // busiest property is whichever one had the most duplicate reports.
    prisma.ticket.groupBy({
      by: ['propertyId'],
      where: {
        propertyId: { in: propertyIds },
        mergedIntoTicketId: null,
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      _count: { _all: true },
    }),
    // Keyed on the ids ALREADY in the report, so a job cannot appear in the
    // trade breakdown without appearing in the expense total.
    workOrderIds.length > 0
      ? prisma.workOrder.findMany({
          where: { id: { in: workOrderIds } },
          select: {
            id: true,
            turnoverProjectId: true,
            ticket: { select: { category: true } },
            pmTemplate: { select: { trade: true } },
          },
        })
      : Promise.resolve([]),
    prisma.lease.findMany({
      where: {
        propertyId: { in: propertyIds },
        status: { in: ['ENDED', 'MONTH_TO_MONTH'] },
        origin: { not: 'RENEWAL' },
        endsOn: { gte: windowStart, lte: windowEnd },
      },
      select: { status: true, renewalLeases: { select: { id: true }, take: 1 } },
    }),
    // Value given away as a move-in concession (review §12) - the economic-
    // occupancy denominator's third term. No write path creates one of these
    // today (grep the app for `CONCESSION`), so this returns nothing yet;
    // the query exists so a future one is counted without a second item.
    prisma.charge.groupBy({
      by: ['propertyId'],
      where: { propertyId: { in: propertyIds }, type: 'CONCESSION', dueOn: { gte: windowStart, lte: windowEnd } },
      _sum: { amountCents: true },
    }),
  ])

  const zoneOf = new Map(properties.map((p) => [p.id, p.timezone]))
  const propertyList = properties.map((p) => ({ id: p.id, name: p.name }))

  // -- Vacancy, per unit then rolled up ------------------------------------
  const vacantDays = new Map<string, number>()
  const availableDays = new Map<string, number>()
  const unitCounts = new Map<string, number>()
  const vacancyLoss = new Map<string, number>()
  const scheduledRent = new Map<string, number>()
  const windowLength = businessDaysBetween(from, to) + 1

  for (const unit of units) {
    const property = properties.find((p) => p.id === unit.propertyId)
    if (!property) continue
    const zone = zoneOf.get(unit.propertyId) ?? 'UTC'

    const intervals = unit.leases.map((lease) => occupiedInterval(lease, zone))
    // `acquiredOn` is a `@db.Date`; `createdAt` is a timestamp. Different
    // readers, same reason as `occupiedInterval` above. `unit.createdAt` is
    // deliberately NOT part of this - see `availableFrom`'s own comment.
    const computedFrom0 = availableFrom({
      acquiredOn: property.acquiredOn != null ? utcToBusinessDate(property.acquiredOn) : null,
      propertyCreatedOn: businessDate(property.createdAt, zone),
      earliestTenancyOn: intervals.reduce<BusinessDate | null>(
        (earliest, interval) =>
          earliest == null || interval.movedInOn < earliest ? interval.movedInOn : earliest,
        null,
      ),
    })
    // R-168: `historyStartsOn` overrides whatever `availableFrom` derived,
    // never the other way round, and only when it is LATER. This owner may
    // genuinely have acquired the property years before this software ever
    // saw it (`acquiredOn` says so correctly) - but this software has no
    // honest vacancy record for that gap, so the later of the two dates is
    // the first day this report can say anything true about.
    const historyStartsOn =
      property.historyStartsOn != null ? utcToBusinessDate(property.historyStartsOn) : null
    const from0 = historyStartsOn && historyStartsOn > computedFrom0 ? historyStartsOn : computedFrom0

    const days = vacantDaysInWindow({ intervals, from, to, availableFrom: from0 })
    const available =
      from0 > to ? 0 : Math.min(windowLength, businessDaysBetween(from0 > from ? from0 : from, to) + 1)

    vacantDays.set(unit.propertyId, (vacantDays.get(unit.propertyId) ?? 0) + days)
    availableDays.set(unit.propertyId, (availableDays.get(unit.propertyId) ?? 0) + available)
    unitCounts.set(unit.propertyId, (unitCounts.get(unit.propertyId) ?? 0) + 1)

    // Economic occupancy (review §12) - DOWN excluded from both terms below.
    // A unit off the market for repairs was never available to rent, so it
    // is neither losing the owner a tenant nor scheduled to bill one.
    if (unit.status !== 'DOWN') {
      const dailyCost = dailyCostOfVacancyCents(unit.marketRentCents)
      if (dailyCost != null) {
        vacancyLoss.set(unit.propertyId, (vacancyLoss.get(unit.propertyId) ?? 0) + dailyCost * days)
      }
      const rentedIntervals: RentedInterval[] = unit.leases.map((lease) => ({
        ...occupiedInterval(lease, zone),
        rentCents: lease.rentCents,
      }))
      scheduledRent.set(
        unit.propertyId,
        (scheduledRent.get(unit.propertyId) ?? 0) +
          scheduledRentCentsInWindow({ intervals: rentedIntervals, from, to }),
      )
    }
  }

  const concessions = new Map(
    concessionCharges.map((row) => [row.propertyId, Math.abs(row._sum.amountCents ?? 0)]),
  )

  // -- Trade attribution and turn cost, both off the export's own lines -----
  const tradeOf = new Map(
    jobTrades.map((job) => [
      job.id,
      tradeForJob({
        ticketCategory: job.ticket?.category ?? null,
        pmTemplateTrade: job.pmTemplate?.trade ?? null,
      }),
    ]),
  )
  const isTurn = new Map(jobTrades.map((job) => [job.id, job.turnoverProjectId != null]))

  const expenseJobs = report.lines.filter(
    (line) => line.section === 'EXPENSE' && line.sourceKind === 'WorkOrder',
  )
  const tradeSpend = spendByTrade(
    expenseJobs.map((line) => ({
      trade: tradeOf.get(line.sourceId) ?? 'UNATTRIBUTED',
      costCents: line.amountCents,
    })),
  )

  const turnCosts = new Map<string, number>()
  for (const line of expenseJobs) {
    if (!isTurn.get(line.sourceId)) continue
    turnCosts.set(line.propertyId, (turnCosts.get(line.propertyId) ?? 0) + line.amountCents)
  }

  const pandl = monthlyPandL({ lines: report.lines, properties: propertyList, from, to })

  return {
    legalEntityId: report.legalEntityId,
    legalEntityName: report.legalEntityName,
    year,
    basis,
    from,
    to,
    pandl,
    snapshot: operatingSnapshot({
      pandl,
      lines: report.lines as readonly ExportLine[],
      unitCounts,
      vacantDays,
      availableDays,
      ticketCounts: new Map(ticketCounts.map((row) => [row.propertyId, row._count._all])),
      turnCosts,
      vacancyLoss,
      scheduledRent,
      concessions,
    }),
    tradeSpend,
    renewal: renewalRate(renewalLeases),
    unmappedCount: report.exceptions.length,
    unmappedCents: report.exceptionCents,
  }
}
