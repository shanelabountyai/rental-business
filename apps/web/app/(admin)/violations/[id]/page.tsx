import { ACCOMMODATION_KIND_LABELS, REQUEST_STATUS_LABELS } from '@rental/core/accommodations'
import { prisma } from '@rental/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  AccommodationLinkPanel,
  AnimalForkNotice,
  CaseHeader,
  CloseCasePanel,
  NoticeSeriesPanel,
  ObservationsPanel,
  type ApplicantOption,
} from '@/components/violations/case-panels.tsx'
import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import {
  closeViolationCase,
  linkAccommodationRequest,
  recordObservation,
} from '@/lib/violations/actions.ts'
import { accommodationPosture, getViolationCase } from '@/lib/violations/queries.ts'

export const metadata = { title: 'Violation case — Rental Operations' }

// NO `loading.tsx` HERE OR ABOVE (R-099): this page calls notFound(), and a
// Suspense boundary above it puts a 200 on the wire before the page runs.
export default async function ViolationCasePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor } = await requireScope('lease.read')
  const scope = await currentScope(actor)
  const found = await getViolationCase(id, scope)
  if (!found) notFound()

  const posture = await accommodationPosture(found.leaseId)

  // Requests on this tenancy not yet attached to any case.
  const linkable = (
    await prisma.accommodationRequest.findMany({
      where: { leaseId: found.leaseId, violationCaseId: null },
      select: { id: true, kind: true, status: true, receivedOn: true },
      orderBy: { receivedOn: 'desc' },
    })
  ).map((request) => ({
    id: request.id,
    label: `${ACCOMMODATION_KIND_LABELS[request.kind]} — ${
      REQUEST_STATUS_LABELS[request.status]
    }`,
  }))

  // Candidates for the legitimize exit: applicants at this property, with
  // whether each has a screening decision on file. The picker shows the
  // unscreened ones too rather than hiding them — an operator who cannot see
  // the person they just invited assumes the product is broken, and the
  // refusal explains itself far better than an empty dropdown does.
  const applicants: ApplicantOption[] =
    found.kind === 'UNAUTHORIZED_OCCUPANT'
      ? (
          await prisma.applicant.findMany({
            where: { application: { propertyId: found.propertyId } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              screeningReport: { select: { decision: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
          })
        ).map((applicant) => ({
          id: applicant.id,
          label: `${applicant.firstName} ${applicant.lastName}`,
          screened: Boolean(applicant.screeningReport?.decision),
        }))
      : []

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Link
        href="/violations"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        ← Violations
      </Link>

      <CaseHeader caseFile={found} />

      {found.kind === 'UNAUTHORIZED_ANIMAL' && (
        <AnimalForkNotice
          hasApprovedAssistanceAnimal={posture.hasApprovedAssistanceAnimal}
          hasUndecidedRequest={posture.hasUndecidedRequest}
        />
      )}

      <ObservationsPanel caseFile={found} action={recordObservation} />

      <NoticeSeriesPanel caseFile={found} />

      <AccommodationLinkPanel
        caseFile={found}
        linkable={linkable}
        action={linkAccommodationRequest}
      />

      {found.status === 'OPEN' ? (
        <CloseCasePanel
          caseFile={found}
          applicants={applicants}
          hasUndecidedRequest={posture.hasUndecidedRequest}
          action={closeViolationCase}
        />
      ) : (
        <section aria-labelledby="case-closed" className="flex flex-col gap-2 border-t pt-4">
          <h2 id="case-closed" className="text-lg font-semibold">
            Closed
          </h2>
          {found.legitimizedApplicantName && (
            <p className="text-sm">
              Legitimized through {found.legitimizedApplicantName}’s application.
            </p>
          )}
          {found.authorizedAnimal && (
            <p className="text-sm">Authorized: {found.authorizedAnimal}.</p>
          )}
          {found.overrideReason && (
            <p className="text-sm">Proceeded despite a warning: {found.overrideReason}</p>
          )}
        </section>
      )}
    </div>
  )
}
