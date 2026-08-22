// The leasing funnel (RPT-06, R-081c).
//
// ===========================================================================
// A FUNNEL COUNTS PEOPLE, NOT EVENTS. A prospect who booked three showings is
// one prospect, and counting the bookings instead would make "conversion"
// exceed 100% for the ordinary case of somebody rescheduling. Every count
// below is a distinct prospect.
//
// AND CONVERSION IS MEASURED WITHIN THE COHORT THAT REACHED THE EARLIER
// STAGE, not stage-count over stage-count. Applying without a recorded
// showing is real and common - a self-serve applicant, a prospect a PM walked
// through before the software knew about it - so `applications / showings`
// can genuinely exceed one. That reads as a broken report rather than as the
// true fact it is. `conversion` here answers "of the prospects who had a
// showing, how many went on to apply", which cannot exceed one, and the
// people who skipped the stage are reported separately as `skipped` rather
// than quietly inflating the ratio they did not belong to.
// ===========================================================================

export const FUNNEL_STAGES = ['inquiry', 'showing', 'application', 'approval'] as const
export type FunnelStage = (typeof FUNNEL_STAGES)[number]

export const FUNNEL_STAGE_LABELS: Record<FunnelStage, string> = {
  inquiry: 'Inquired',
  showing: 'Viewed the home',
  application: 'Applied',
  approval: 'Approved',
}

/// One named prospect and the furthest each stage got. Every field is
/// nullable because a funnel's whole job is to show where people stop.
export interface ProspectJourney {
  prospectId: string
  /// A syndication network name, or "direct". Carried from the inquiry.
  source: string
  showedAt: Date | null
  appliedAt: Date | null
  approvedAt: Date | null
}

export interface FunnelStep {
  stage: FunnelStage
  label: string
  count: number
  /// Of the prospects who reached the PREVIOUS stage, the share who also
  /// reached this one. Null on the first stage, and null when nobody
  /// reached the previous stage - zero would read as "everybody dropped
  /// out", a different and false claim.
  conversion: number | null
  /// Reached this stage without the previous one ever being recorded. Not
  /// an error: a self-serve applicant who never booked a showing is a real
  /// person, and hiding them would make the stage counts disagree with the
  /// conversion arithmetic above them.
  skipped: number
}

function reached(journey: ProspectJourney, stage: FunnelStage): boolean {
  switch (stage) {
    case 'inquiry':
      return true
    case 'showing':
      return journey.showedAt != null
    case 'application':
      return journey.appliedAt != null
    case 'approval':
      return journey.approvedAt != null
  }
}

/**
 * The funnel, as a list of steps with cohort conversion between them.
 *
 * Every stage is present even at zero — the same "a report never silently
 * omits a row" rule `resolutionByPriority` and `agingTotals` already keep. A
 * missing stage reads as a data gap; a zero reads as a fact.
 */
export function funnelSteps(journeys: readonly ProspectJourney[]): FunnelStep[] {
  return FUNNEL_STAGES.map((stage, index) => {
    const here = journeys.filter((journey) => reached(journey, stage))
    const previous = FUNNEL_STAGES[index - 1]

    if (!previous) {
      return { stage, label: FUNNEL_STAGE_LABELS[stage], count: here.length, conversion: null, skipped: 0 }
    }

    const cohort = journeys.filter((journey) => reached(journey, previous))
    const advanced = cohort.filter((journey) => reached(journey, stage)).length
    return {
      stage,
      label: FUNNEL_STAGE_LABELS[stage],
      count: here.length,
      conversion: cohort.length > 0 ? advanced / cohort.length : null,
      skipped: here.length - advanced,
    }
  })
}

export interface SourceQuality {
  source: string
  inquiries: number
  showings: number
  applications: number
  approvals: number
  /// Approvals per inquiry — the end-to-end number, which is what "quality"
  /// means for a channel: a listing site sending a hundred people who never
  /// qualify is worse than one sending five who do.
  approvalRate: number
}

/**
 * Per-channel quality (RPT-06's "cost/quality by channel" — the quality half).
 *
 * COST IS NOT HERE, AND ITS ABSENCE IS NAMED RATHER THAN SHOWN AS ZERO.
 * Nothing in this product records what a listing on a network costs — there
 * is no ad-spend entity and no invoice carrying one — so a cost-per-lead
 * column would be a zero standing in for "unknown", which is R-078's own
 * reason for naming its unfillable Schedule E lines rather than blanking
 * them. Whoever adds ad spend adds the column here.
 *
 * Sorted by approval rate, then by inquiry volume — a channel with one
 * inquiry and one approval is 100% and should not outrank one with forty
 * inquiries and thirty approvals, so volume breaks the tie downward.
 */
export function sourceQuality(journeys: readonly ProspectJourney[]): SourceQuality[] {
  const bySource = new Map<string, SourceQuality>()

  for (const journey of journeys) {
    const row = bySource.get(journey.source) ?? {
      source: journey.source,
      inquiries: 0,
      showings: 0,
      applications: 0,
      approvals: 0,
      approvalRate: 0,
    }
    row.inquiries += 1
    if (journey.showedAt) row.showings += 1
    if (journey.appliedAt) row.applications += 1
    if (journey.approvedAt) row.approvals += 1
    bySource.set(journey.source, row)
  }

  return [...bySource.values()]
    .map((row) => ({ ...row, approvalRate: row.inquiries > 0 ? row.approvals / row.inquiries : 0 }))
    .sort((a, b) => b.approvalRate - a.approvalRate || b.inquiries - a.inquiries)
}

export interface LeadCount {
  source: string
  visits: number
}

/**
 * Anonymous listing visits per source (RPT-06's "leads by source").
 *
 * DELIBERATELY NOT JOINED TO THE FUNNEL ABOVE, and this is the honest part.
 * A `ListingLead` is a page visit with a `?src=` tag and no person attached
 * (R-057 built it that way on purpose); a `Prospect` is somebody who typed
 * their name into a form. Nothing keys one to the other, so a visit-to-
 * inquiry conversion would be two unrelated populations divided by each
 * other and presented as a rate. They are reported side by side instead.
 */
export function leadsBySource(leads: readonly { source: string }[]): LeadCount[] {
  const counts = new Map<string, number>()
  for (const lead of leads) counts.set(lead.source, (counts.get(lead.source) ?? 0) + 1)
  return [...counts.entries()]
    .map(([source, visits]) => ({ source, visits }))
    .sort((a, b) => b.visits - a.visits || a.source.localeCompare(b.source))
}
