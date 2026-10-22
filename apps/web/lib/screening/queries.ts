import 'server-only'

import { deliveryNarrative } from '@rental/core/comms'
import { businessDate, friendlyTimestamp, utcToBusinessDate } from '@rental/core/scheduling'
import { evaluateCriteria, type CriterionEvaluation } from '@rental/core/screening'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import { currentScreeningCriteria, outOfOrderApplicationIds } from './order.ts'

// Reads for the Prospect detail page's screening section (LEASE-04, R-060).
// Folded in there rather than a separate screen, the same call R-059 made
// for Application - Prospect.status already reads SCREENED/APPROVED, and
// this is the attached data for those stages, not a second list.

export interface ApplicantScreeningSummary {
  applicantId: string
  firstName: string
  lastName: string
  reportStatus: 'NONE' | 'ORDERED' | 'COMPLETE' | 'FAILED'
  criteria: CriterionEvaluation[]
  decision: string | null
  decisionNotes: string | null
  /// R-269: the label of the reason picked from `DecisionReason`.
  decisionReason: string | null
  decidedAt: Date | null
  /// R-269: every "request more info", oldest first.
  infoRequests: { id: string; request: string; requestedAt: Date }[]
  /// R-270: every decision or info-request message sent to them, one line
  /// per channel, with what actually happened - a co-applicant is never
  /// texted (no consent is possible for them), so this is how staff learn
  /// they have to make contact themselves.
  messages: { id: string; label: string; channel: string; narrative: string }[]
  /// R-061: set only for DECLINED/APPROVED_WITH_CONDITIONS. Null noticeId
  /// with a non-null decision means one is still owed and unresolved - see
  /// `adverseActionOwed()`.
  adverseAction: {
    noticeId: string
    sentAt: Date | null
    overriddenAt: Date | null
  } | null
}

export interface ApplicationScreeningSummary {
  applicants: ApplicantScreeningSummary[]
  /// True when an earlier-completed application for the same listing has
  /// no decision yet - the ScreeningDecisionForm shows the deviation-reason
  /// field up front rather than making staff guess why a first attempt was
  /// rejected. Purely informational here; staff-actions.ts re-checks this
  /// for real at write time (a read can go stale between render and
  /// submit).
  outOfOrder: boolean
  /// R-269: the active decline-reason list, for the decision form.
  reasons: { value: string; label: string }[]
  /// R-270: the lease draft opened when the household was approved.
  leaseDraftId: string | null
  /// R-270 (D-336): every applicant approved and no draft - the household was
  /// told a lease is coming and nobody has one open.
  approvedWithoutDraft: boolean
}

const MESSAGE_LABELS: Record<string, string> = {
  'application.approved': 'Approval',
  'application.declined': 'Decline',
  'application.approved_with_conditions': 'Conditional approval',
  'application.info_request': 'More-info request',
}

export async function screeningForApplication(
  applicationId: string,
  scope: ResolvedScope,
): Promise<ApplicationScreeningSummary | null> {
  const application = await prisma.application.findFirst({
    where: { id: applicationId, propertyId: { in: scope.propertyIds } },
    include: {
      listing: { select: { rentCents: true } },
      property: { select: { timezone: true } },
      leaseDraft: { select: { id: true } },
      applicants: {
        include: {
          screeningReport: {
            include: {
              adverseActionNotice: { select: { id: true, servedAt: true } },
              decisionReason: { select: { label: true } },
            },
          },
          infoRequests: {
            select: { id: true, request: true, requestedAt: true },
            orderBy: { requestedAt: 'asc' },
          },
        },
        orderBy: [{ isLead: 'desc' }, { createdAt: 'asc' }],
      },
    },
  })
  if (!application) return null

  const currentCriteria = await currentScreeningCriteria()

  const sent = await prisma.notification.findMany({
    where: {
      recipientType: 'APPLICANT',
      recipientId: { in: application.applicants.map((a) => a.id) },
      templateKey: { in: Object.keys(MESSAGE_LABELS) },
    },
    include: { delivery: true },
    orderBy: { createdAt: 'asc' },
  })
  const zone = application.property.timezone

  // Every version actually pinned on a report here, fetched by ITS OWN row
  // - not assumed to equal `currentCriteria` (Applicant.feeCents's own
  // snapshot reasoning, restated: a version bump after ordering must not
  // silently move what an already-screened applicant is shown against).
  const pinnedVersions = [
    ...new Set(
      application.applicants
        .map((a) => a.screeningReport?.criteriaVersion)
        .filter((v): v is number => v != null && v !== currentCriteria.version),
    ),
  ]
  const pastCriteria = pinnedVersions.length
    ? await prisma.screeningCriteria.findMany({ where: { version: { in: pinnedVersions } } })
    : []
  const criteriaByVersion = new Map(
    [currentCriteria, ...pastCriteria].map((c) => [c.version, c]),
  )

  const applicants = application.applicants.map((applicant): ApplicantScreeningSummary => {
    const report = applicant.screeningReport
    const criteriaConfig = report
      ? (criteriaByVersion.get(report.criteriaVersion) ?? currentCriteria)
      : currentCriteria

    return {
      applicantId: applicant.id,
      firstName: applicant.firstName,
      lastName: applicant.lastName,
      reportStatus: (report?.status as 'ORDERED' | 'COMPLETE' | 'FAILED' | undefined) ?? 'NONE',
      criteria: evaluateCriteria(criteriaConfig, {
        monthlyIncomeCents: applicant.monthlyIncomeCents,
        rentCents: application.listing.rentCents,
        creditScore: report?.creditScore ?? null,
        evictionRecordFound: report?.evictionRecordFound ?? null,
        criminalRecordFound: report?.criminalRecordFound ?? null,
        evictionRecordOn: report?.evictionRecordOn ? utcToBusinessDate(report.evictionRecordOn) : null,
        criminalRecordOn: report?.criminalRecordOn ? utcToBusinessDate(report.criminalRecordOn) : null,
        // A decided applicant keeps the window the decision was made in.
        asOf: businessDate(report?.decidedAt ?? new Date(), application.property.timezone),
      }),
      decision: report?.decision ?? null,
      decisionNotes: report?.decisionNotes ?? null,
      decisionReason: report?.decisionReason?.label ?? null,
      decidedAt: report?.decidedAt ?? null,
      infoRequests: applicant.infoRequests,
      messages: sent
        .filter((n) => n.recipientId === applicant.id)
        .map((n) => ({
          id: n.id,
          label: MESSAGE_LABELS[n.templateKey]!,
          channel: n.channel === 'SMS' ? 'Text' : 'Email',
          narrative: n.delivery
            ? deliveryNarrative(
                {
                  status: n.delivery.status,
                  detail: n.delivery.suppressedReason ?? n.delivery.failureCode,
                  sentAt: n.delivery.sentAt,
                  deliveredAt: n.delivery.deliveredAt,
                  failedAt: n.delivery.failedAt,
                },
                (at) => friendlyTimestamp(at, zone),
              )
            : 'no delivery recorded',
        })),
      adverseAction: report?.adverseActionNotice
        ? {
            noticeId: report.adverseActionNotice.id,
            sentAt: report.adverseActionNotice.servedAt,
            overriddenAt: report.adverseActionOverriddenAt,
          }
        : null,
    }
  })

  const outOfOrder = (await outOfOrderApplicationIds(application)).length > 0

  const reasons = await activeDecisionReasons()

  const allApproved =
    applicants.length > 0 &&
    applicants.every((a) => a.decision === 'APPROVED' || a.decision === 'APPROVED_WITH_CONDITIONS')
  return {
    applicants,
    outOfOrder,
    reasons,
    leaseDraftId: application.leaseDraft?.id ?? null,
    approvedWithoutDraft: allApproved && !application.leaseDraft,
  }
}

/** R-269: the decline-reason list, oldest first, retired rows left out. */
export async function activeDecisionReasons() {
  const rows = await prisma.decisionReason.findMany({
    where: { retiredAt: null },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => ({ value: row.code, label: row.label }))
}
