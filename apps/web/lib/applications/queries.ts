import 'server-only'

import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for Application/Applicant (LEASE-03, R-059).
//
// Folded into the Prospect detail page rather than a separate pipeline
// screen (see that page's own comment) - Prospect.status IS the pipeline
// PM-04 already reads, and an Application is the attached data for the
// APPLIED stage, not a second list to keep in sync with it.

export interface ApplicantSummary {
  id: string
  isLead: boolean
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  feeCents: number | null
  feePaidAt: Date | null
  formSubmittedAt: Date | null
  completedAt: Date | null
  documentCount: number
}

export interface ApplicationSummary {
  id: string
  completedAt: Date | null
  createdAt: Date
  applicants: ApplicantSummary[]
}

export async function applicationForProspect(
  prospectId: string,
  scope: ResolvedScope,
): Promise<ApplicationSummary | null> {
  const application = await prisma.application.findFirst({
    where: { prospectId, propertyId: { in: scope.propertyIds } },
    // Most recent, if a prospect somehow has more than one (a withdrawn
    // application tried again) - the pipeline shows the live one.
    orderBy: { createdAt: 'desc' },
    include: {
      applicants: {
        orderBy: [{ isLead: 'desc' }, { createdAt: 'asc' }],
        include: { _count: { select: { documents: true } } },
      },
    },
  })
  if (!application) return null

  return {
    id: application.id,
    completedAt: application.completedAt,
    createdAt: application.createdAt,
    applicants: application.applicants.map((a) => ({
      id: a.id,
      isLead: a.isLead,
      firstName: a.firstName,
      lastName: a.lastName,
      email: a.email,
      phone: a.phone,
      feeCents: a.feeCents,
      feePaidAt: a.feePaidAt,
      formSubmittedAt: a.formSubmittedAt,
      completedAt: a.completedAt,
      documentCount: a._count.documents,
    })),
  }
}

/// Names and status only, not contact info - shown on a CO-APPLICANT's own
/// page so they can see who else is applying, without leaking another
/// household member's email or phone to them.
export interface HouseholdMember {
  id: string
  isLead: boolean
  firstName: string
  lastName: string
  completedAt: Date | null
}

export async function householdFor(applicationId: string): Promise<HouseholdMember[]> {
  return prisma.applicant.findMany({
    where: { applicationId },
    orderBy: [{ isLead: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, isLead: true, firstName: true, lastName: true, completedAt: true },
  })
}

export interface ApplicantDocumentSummary {
  id: string
  fileName: string
  createdAt: Date
}

export async function documentsForApplicant(applicantId: string): Promise<ApplicantDocumentSummary[]> {
  return prisma.document.findMany({
    where: { applicantId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, fileName: true, createdAt: true },
  })
}
