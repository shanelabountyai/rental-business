import 'server-only'

import {
  type FunnelStep,
  type LeadCount,
  type ProspectJourney,
  type SourceQuality,
  daysToFill,
  funnelSteps,
  leadsBySource,
  sourceQuality,
} from '@rental/core/metrics'
import { businessDate, businessDaysBetween, utcToBusinessDate } from '@rental/core/scheduling'
import type { BusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// The leasing funnel's reads (RPT-06, R-081c). Fetch here, decide in
// `packages/core/metrics/funnel.ts` — the same split every other report uses.
//
// ===========================================================================
// THE JOURNEY IS ASSEMBLED PER PROSPECT, NOT PER EVENT, and that is the whole
// reason this file exists rather than four `groupBy` calls. A prospect who
// rebooked twice has three `Showing` rows and is one person who viewed the
// home; counting rows would put conversion over 100% for the ordinary case of
// somebody moving an appointment. Each stage collapses to the EARLIEST
// qualifying moment for that prospect.
// ===========================================================================

export interface VacancyFill {
  unitId: string
  unitName: string
  propertyName: string
  vacatedOn: BusinessDate
  filledOn: BusinessDate | null
  days: number
  isFinal: boolean
  /// Days from the notice to vacate (or from move-out, where no notice was
  /// recorded) to the first publish of a listing for this unit. Null means
  /// it has not been listed for this vacancy. Zero or small is the goal: the
  /// notice period is the only time a unit can be marketed for free (R-219).
  daysToList: number | null
}

export interface LeasingFunnelReport {
  from: BusinessDate
  to: BusinessDate
  steps: FunnelStep[]
  sources: SourceQuality[]
  leads: LeadCount[]
  fills: VacancyFill[]
  /// MEDIAN, not mean, and of the FINAL fills only.
  ///
  /// Median because one house that sat empty for two hundred days while a
  /// roof was replaced would drag a mean far away from what the portfolio
  /// actually does, and "typical time to fill" is the question being asked.
  /// Final-only because a still-vacant unit's running count is not a
  /// days-to-fill at all — it is a number that has not finished happening,
  /// and including it would make the headline improve every time a new
  /// vacancy opened. The still-vacant ones are in `fills`, flagged.
  medianDaysToFill: number | null
  /// Median of the vacancies that WERE listed; same reasoning as above.
  medianDaysToList: number | null
}

export async function leasingFunnel(
  scope: ResolvedScope,
  from: BusinessDate,
  to: BusinessDate,
): Promise<LeasingFunnelReport> {
  const propertyIds = scope.propertyIds
  if (propertyIds.length === 0) {
    return { from, to, steps: funnelSteps([]), sources: [], leads: [], fills: [], medianDaysToFill: null, medianDaysToList: null }
  }

  const windowStart = new Date(`${from}T00:00:00.000Z`)
  const windowEnd = new Date(`${to}T23:59:59.999Z`)

  const [prospects, leads, properties] = await Promise.all([
    // THE WINDOW IS THE INQUIRY DATE, not each stage's own date. A funnel
    // whose stages were each filtered by their own timestamp would report
    // approvals for people who inquired before the window and drop the
    // approvals of people who inquired inside it — a cohort has to be one
    // cohort, followed forward, or the conversions between its stages are
    // ratios of different populations.
    prisma.prospect.findMany({
      where: {
        propertyId: { in: propertyIds },
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        id: true,
        source: true,
        showings: {
          where: { status: { not: 'CANCELED' } },
          orderBy: { scheduledStart: 'asc' },
          take: 1,
          select: { scheduledStart: true },
        },
        applications: {
          where: { completedAt: { not: null } },
          orderBy: { completedAt: 'asc' },
          take: 1,
          select: {
            completedAt: true,
            applicants: {
              where: { screeningReport: { decision: { in: ['APPROVED', 'APPROVED_WITH_CONDITIONS'] } } },
              select: { screeningReport: { select: { decidedAt: true } } },
            },
          },
        },
      },
    }),
    prisma.listingLead.findMany({
      where: {
        listing: { propertyId: { in: propertyIds } },
        occurredAt: { gte: windowStart, lte: windowEnd },
      },
      select: { source: true },
    }),
    prisma.property.findMany({
      where: { id: { in: propertyIds } },
      select: {
        id: true,
        name: true,
        timezone: true,
        units: {
          select: {
            id: true,
            name: true,
            leases: {
              select: {
                startsOn: true,
                endsOn: true,
                moveInAt: true,
                moveOutAt: true,
                noticeGivenAt: true,
                // R-226: a renewal is the same tenancy on a new row (D-54).
                renewalLeases: { where: { status: { notIn: ['DRAFT', 'PENDING_SIGNATURE'] } }, select: { id: true } },
              },
            },
            // `publishedAt` is the latest publish, so a listing unpublished
            // and republished reads late here. ponytail: add a publish
            // history if republishing turns out to be common.
            listings: { where: { publishedAt: { not: null } }, select: { publishedAt: true } },
          },
        },
      },
    }),
  ])

  const journeys: ProspectJourney[] = prospects.map((prospect) => {
    const application = prospect.applications[0]
    // APPROVED_WITH_CONDITIONS counts as approved, deliberately: the household
    // was told yes, and RPT-06 is measuring whether a channel produces people
    // this business will rent to. A conditional approval that turns into a
    // signed lease is a success by every measure a leasing agent cares about.
    // The conditions themselves are the screening record's business, not the
    // funnel's.
    const decided = application?.applicants
      .map((applicant) => applicant.screeningReport?.decidedAt ?? null)
      .filter((at): at is Date => at != null)
      .sort((a, b) => a.getTime() - b.getTime())[0]

    return {
      prospectId: prospect.id,
      source: prospect.source,
      showedAt: prospect.showings[0]?.scheduledStart ?? null,
      appliedAt: application?.completedAt ?? null,
      approvedAt: decided ?? null,
    }
  })

  // -- Days to fill, per vacancy that ENDED inside the window ---------------
  //
  // Reads `moveOutAt`/`moveInAt` as real timestamps through the property's
  // own zone, and `endsOn`/`startsOn` as `@db.Date` calendar days that no
  // zone may touch. Mixing the two is the R-042 defect, and here it would
  // move a fill across a day boundary and change the number being reported.
  const fills: VacancyFill[] = []
  for (const property of properties) {
    const zone = property.timezone
    for (const unit of property.units) {
      // A lease a renewal took over did not vacate anything - the tenant is
      // still in the house - so it must not be counted as a vacancy "filled"
      // the next day by its own successor, which would drag the median
      // toward zero by one per renewal.
      const ends = unit.leases
        .filter((lease) => lease.renewalLeases.length === 0)
        .map((lease) => ({
          vacatedOn:
            lease.moveOutAt != null
              ? businessDate(lease.moveOutAt, zone)
              : lease.endsOn != null
                ? utcToBusinessDate(lease.endsOn)
                : null,
          noticeOn: lease.noticeGivenAt != null ? businessDate(lease.noticeGivenAt, zone) : null,
        }))
        .filter((row): row is { vacatedOn: BusinessDate; noticeOn: BusinessDate | null } => row.vacatedOn != null)

      const published = unit.listings.map((listing) => businessDate(listing.publishedAt!, zone)).sort()

      const starts = unit.leases
        .map((lease) =>
          lease.moveInAt != null ? businessDate(lease.moveInAt, zone) : utcToBusinessDate(lease.startsOn),
        )
        .sort()

      for (const { vacatedOn, noticeOn } of ends) {
        if (vacatedOn < from || vacatedOn > to) continue
        // The next tenancy to START after this one ended. Not "the newest
        // lease": a unit turned twice in a year has two vacancies, and
        // pairing both with the latest move-in would report the second
        // vacancy's answer for the first one too.
        const filledOn = starts.find((start) => start >= vacatedOn) ?? null
        const fill = daysToFill({ vacatedOn, filledOn, asOf: to })
        const clockFrom = noticeOn ?? vacatedOn
        const listedOn = published.find((on) => on >= clockFrom && (filledOn == null || on <= filledOn))
        fills.push({
          unitId: unit.id,
          unitName: unit.name,
          propertyName: property.name,
          vacatedOn,
          filledOn,
          days: fill.days,
          isFinal: fill.isFinal,
          daysToList: listedOn != null ? businessDaysBetween(clockFrom, listedOn) : null,
        })
      }
    }
  }

  fills.sort((a, b) => b.days - a.days || a.propertyName.localeCompare(b.propertyName))

  const medianDaysToFill = median(fills.filter((fill) => fill.isFinal).map((fill) => fill.days))
  const medianDaysToList = median(
    fills.map((fill) => fill.daysToList).filter((days): days is number => days != null),
  )

  return {
    from,
    to,
    steps: funnelSteps(journeys),
    sources: sourceQuality(journeys),
    leads: leadsBySource(leads),
    fills,
    medianDaysToFill,
    medianDaysToList,
  }
}

function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = sorted.length / 2
  return sorted.length % 2 === 1 ? sorted[mid - 0.5] : (sorted[mid - 1] + sorted[mid]) / 2
}
