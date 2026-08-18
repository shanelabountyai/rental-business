import 'server-only'

import { earlierUndecidedApplications } from '@rental/core/screening'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { screeningAdapter } from './provider.ts'

// Ordering a screening report (LEASE-04, R-060).
//
// "APPLICANT-INITIATED": triggered by the applicant's own submission, not a
// separate staff action or a fake hosted-provider redirect page - there is
// no real vendor chosen yet (D-7: Phase 3), so a round trip through a mock
// "continue to provider" screen would be theater with nothing behind it.
// Completing the household's own Application (fee-webhook.ts's
// maybeCompleteApplication, itself triggered by the applicant's own
// submitted form and paid fee) is what "the applicant initiated this" means
// here - the same call R-059 already made for `Application.completedAt`
// itself being the applicant's own doing, not staff's.
//
// NO PROVIDER CALL INSIDE A DATABASE TRANSACTION - lib/listings/actions.ts's
// own stated rule, restated for a second outbound call: a provider outage
// must not hold a pooled connection open for its duration.

export interface ApplicantToScreen {
  id: string
  applicationId: string
}

/**
 * The ScreeningCriteria version in force right now. Throws rather than
 * defaulting if none exists - the same posture `rulesFor()` gives a missing
 * JurisdictionRule (packages/core's own convention: a silently invented
 * default is worse than a loud failure here).
 */
export async function currentScreeningCriteria() {
  const criteria = await prisma.screeningCriteria.findFirst({
    where: { effectiveTo: null },
    orderBy: { version: 'desc' },
  })
  if (!criteria) {
    throw new Error(
      'No ScreeningCriteria configured - seed.mts should have created v1. Screening cannot run with nothing to evaluate against.',
    )
  }
  return criteria
}

/** Idempotent: does nothing if this applicant already has a report. */
export async function orderScreeningForApplicant(applicant: ApplicantToScreen): Promise<void> {
  const existing = await prisma.screeningReport.findUnique({
    where: { applicantId: applicant.id },
  })
  if (existing) return

  const criteria = await currentScreeningCriteria()
  const result = await screeningAdapter.order({ applicantId: applicant.id })

  await prisma.screeningReport.create({
    data: {
      applicantId: applicant.id,
      providerId: result.providerId,
      status: result.status,
      faultCode: result.faultCode ?? null,
      creditScore: result.creditScore ?? null,
      evictionRecordFound: result.evictionRecordFound ?? null,
      criminalRecordFound: result.criminalRecordFound ?? null,
      criteriaVersion: criteria.version,
      completedAt: result.status === 'COMPLETE' ? new Date() : null,
    },
  })

  await auditAsSystem(`applicant:${applicant.id}`, {
    action: 'screening.ordered',
    entityType: 'Applicant',
    entityId: applicant.id,
    after: { providerId: result.providerId, status: result.status },
  })
}

/**
 * Orders a report for every applicant in the household, then - once every
 * one of them has completed - moves the Prospect pipeline to SCREENED
 * (packages/db/prisma/schema.prisma's own comment on ProspectStatus names
 * this the stage nothing automated has driven to yet). A FAILED report
 * leaves the household short of "every one completed" rather than
 * advancing the stage on a report nobody can actually read yet; staff see
 * the failure on the Prospect page and can re-run it by calling this again
 * once the underlying issue is understood (retry is not built here - a real
 * gap, left for whoever revisits provider fault handling with field data).
 */
export async function orderScreeningForApplication(applicationId: string): Promise<void> {
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: { applicants: { select: { id: true, applicationId: true } } },
  })

  for (const applicant of application.applicants) {
    await orderScreeningForApplicant(applicant)
  }

  const reports = await prisma.screeningReport.findMany({
    where: { applicantId: { in: application.applicants.map((a) => a.id) } },
    select: { status: true },
  })
  const allComplete = reports.length === application.applicants.length &&
    reports.every((r) => r.status === 'COMPLETE')
  if (!allComplete) return

  // Guarded on the PRECEDING stage, not a bare update - this function is
  // idempotent and can run again (a retried webhook, a re-invited
  // co-applicant), and by then staff may already have moved the prospect
  // further by hand (advanceProspectStage's own "status is free-form for
  // staff"). Only ever advances FROM 'APPLIED', never overwrites a later
  // stage a person already set.
  await prisma.prospect.updateMany({
    where: { id: application.prospectId, status: 'APPLIED' },
    data: { status: 'SCREENED' },
  })
}

/**
 * Ids of applications for the same listing that completed before this one
 * and have no decision on any of their applicants yet - shared by
 * queries.ts (read, for the form's up-front hint) and staff-actions.ts
 * (write, the real enforcement at decision time). Both call this rather
 * than each re-deriving the same sibling query.
 */
export async function outOfOrderApplicationIds(application: {
  id: string
  listingId: string
  completedAt: Date | null
}): Promise<string[]> {
  if (!application.completedAt) return []

  const siblings = await prisma.application.findMany({
    where: {
      listingId: application.listingId,
      completedAt: { not: null },
      id: { not: application.id },
    },
    include: { applicants: { include: { screeningReport: { select: { decision: true } } } } },
  })

  return earlierUndecidedApplications(
    { applicationId: application.id, completedAt: application.completedAt, decided: false },
    siblings.map((s) => ({
      applicationId: s.id,
      completedAt: s.completedAt!,
      decided: s.applicants.every((a) => a.screeningReport?.decision != null),
    })),
  )
}
