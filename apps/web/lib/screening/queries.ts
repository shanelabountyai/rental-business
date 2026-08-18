import 'server-only'

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
  decidedAt: Date | null
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
}

export async function screeningForApplication(
  applicationId: string,
  scope: ResolvedScope,
): Promise<ApplicationScreeningSummary | null> {
  const application = await prisma.application.findFirst({
    where: { id: applicationId, propertyId: { in: scope.propertyIds } },
    include: {
      listing: { select: { rentCents: true } },
      applicants: {
        include: {
          screeningReport: { include: { adverseActionNotice: { select: { id: true, servedAt: true } } } },
        },
        orderBy: [{ isLead: 'desc' }, { createdAt: 'asc' }],
      },
    },
  })
  if (!application) return null

  const currentCriteria = await currentScreeningCriteria()

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
      }),
      decision: report?.decision ?? null,
      decisionNotes: report?.decisionNotes ?? null,
      decidedAt: report?.decidedAt ?? null,
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

  return { applicants, outOfOrder }
}
