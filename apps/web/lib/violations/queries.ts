import 'server-only'

import { cureClock, type CureClock } from '@rental/core/evictions'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import type {
  ViolationGround,
  ViolationKind,
  ViolationOutcome,
  ViolationStatus,
} from '@rental/core/violations'
import { prisma } from '@rental/db'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import type { ResolvedScope } from '@/lib/scope/types.ts'

// Reads for lease-violation case files (RISK-02, RISK-03; R-088).

export interface ObservationView {
  id: string
  ground: ViolationGround | null
  observedOn: string
  note: string
  recordedAt: Date
  recordedByName: string
  photos: { id: string; fileName: string; capturedAt: Date | null }[]
}

export interface CaseNoticeView {
  id: string
  type: string
  generatedAt: Date
  servedAt: Date | null
}

export interface CaseAccommodationView {
  id: string
  kind: string
  status: string
  receivedOn: string
}

export interface CaseView {
  id: string
  propertyId: string
  propertyName: string
  unitLabel: string
  leaseId: string
  tenantNames: string[]
  timezone: string
  kind: ViolationKind
  status: ViolationStatus
  outcome: ViolationOutcome | null
  outcomeNote: string | null
  overrideReason: string | null
  openedAt: Date
  openedByName: string
  closedAt: Date | null
  legitimizedApplicantId: string | null
  legitimizedApplicantName: string | null
  authorizedAnimal: string | null
  observations: ObservationView[]
  notices: CaseNoticeView[]
  accommodationRequests: CaseAccommodationView[]
  /// Where the cure period stands, across the whole notice series.
  cure: CureClock
}

// Type derived from the call, not hand-written: Prisma's payload generics do
// not survive a hand-built `include` constant (an `as const` makes every
// nested `orderBy` array readonly, which the generated types reject), and a
// fetch function whose return type IS the row cannot drift from its own
// select.
async function fetchCase(id: string) {
  return prisma.violationCase.findUnique({
    where: { id },
    include: {
      property: { select: { id: true, name: true, timezone: true, state: true, county: true } },
      unit: { select: { name: true } },
      lease: {
        select: {
          id: true,
          leaseTenants: { select: { tenant: { select: { firstName: true, lastName: true } } } },
        },
      },
      openedBy: { select: { name: true } },
      legitimizedApplicant: { select: { id: true, firstName: true, lastName: true } },
      observations: {
        orderBy: [{ observedOn: 'desc' }, { recordedAt: 'desc' }],
        include: {
          recordedBy: { select: { name: true } },
          photos: { select: { id: true, fileName: true, capturedAt: true } },
        },
      },
      notices: {
        orderBy: { generatedAt: 'asc' },
        select: {
          id: true,
          type: true,
          generatedAt: true,
          servedAt: true,
          deliveries: { select: { servedAt: true, permittedByJurisdiction: true } },
        },
      },
      accommodationRequests: {
        orderBy: { receivedOn: 'desc' },
        select: { id: true, kind: true, status: true, receivedOn: true },
      },
    },
  })
}

type CaseRow = Awaited<ReturnType<typeof fetchCase>>

/**
 * THE CURE CLOCK IS R-083's, NOT A SECOND ONE.
 *
 * `cureClock` already knows the rules that matter — it runs from the EARLIEST
 * good service rather than the latest, so re-serving cannot restart it, and it
 * reports a clock with no deadline rather than an expired one when this
 * product has not been taught the state's period. All that changes here is
 * which jurisdiction number it is handed: `leaseViolationCureDays` for a
 * non-monetary breach, not `payOrQuitDays`.
 *
 * The services are pooled across the WHOLE notice series, which is the same
 * "earliest good service wins" rule applied one level up: a landlord who
 * served a defective notice in March and a good one in June has a clock that
 * started in June, and one who served twice correctly does not get two.
 */
async function cureFor(row: NonNullable<CaseRow>): Promise<CureClock> {
  const today = businessDate(new Date(), row.property.timezone)
  // Throws when this state has no rule row at all, which is a configuration
  // failure rather than a case-file one - the clock then reports "not
  // configured" instead of taking the page down with it.
  const rule = await rulesFor(
    { state: row.property.state, county: row.property.county },
    new Date(),
  ).catch(() => null)
  const services = row.notices.flatMap((notice) =>
    notice.deliveries.map((delivery) => ({
      servedOn: utcToBusinessDate(delivery.servedAt),
      permittedByJurisdiction: delivery.permittedByJurisdiction,
    })),
  )
  return cureClock(services, rule?.leaseViolationCureDays ?? null, today)
}

function toView(row: NonNullable<CaseRow>, cure: CureClock): CaseView {
  return {
    id: row.id,
    propertyId: row.propertyId,
    propertyName: row.property.name,
    unitLabel: row.unit.name,
    leaseId: row.leaseId,
    tenantNames: row.lease.leaseTenants.map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`),
    timezone: row.property.timezone,
    kind: row.kind as ViolationKind,
    status: row.status as ViolationStatus,
    outcome: row.outcome as ViolationOutcome | null,
    outcomeNote: row.outcomeNote,
    overrideReason: row.overrideReason,
    openedAt: row.openedAt,
    openedByName: row.openedBy.name,
    closedAt: row.closedAt,
    legitimizedApplicantId: row.legitimizedApplicantId,
    legitimizedApplicantName: row.legitimizedApplicant
      ? `${row.legitimizedApplicant.firstName} ${row.legitimizedApplicant.lastName}`
      : null,
    authorizedAnimal: row.authorizedAnimal,
    observations: row.observations.map((o) => ({
      id: o.id,
      ground: o.ground as ViolationGround | null,
      observedOn: utcToBusinessDate(o.observedOn),
      note: o.note,
      recordedAt: o.recordedAt,
      recordedByName: o.recordedBy.name,
      photos: o.photos,
    })),
    notices: row.notices.map((n) => ({
      id: n.id,
      type: n.type,
      generatedAt: n.generatedAt,
      servedAt: n.servedAt,
    })),
    accommodationRequests: row.accommodationRequests.map((a) => ({
      id: a.id,
      kind: a.kind,
      status: a.status,
      receivedOn: utcToBusinessDate(a.receivedOn),
    })),
    cure,
  }
}

/// One case, scoped. Returns null rather than throwing for anything outside
/// the caller's scope, so the page answers 404 rather than 403 (ROLE-01).
export async function getViolationCase(
  caseId: string,
  scope: ResolvedScope,
): Promise<CaseView | null> {
  if (scope.propertyIds.length === 0) return null
  const row = await fetchCase(caseId)
  if (!row || !scope.propertyIds.includes(row.propertyId)) return null
  return toView(row, await cureFor(row))
}

export interface CaseSummary {
  id: string
  kind: ViolationKind
  status: ViolationStatus
  outcome: ViolationOutcome | null
  propertyName: string
  unitLabel: string
  leaseId: string
  tenantNames: string[]
  openedAt: Date
  observationCount: number
  lastObservedOn: string | null
  openAccommodationCount: number
}

/**
 * Open cases first, oldest first inside that.
 *
 * A violation case's failure mode is not being wrong, it is being forgotten:
 * three photographs taken in March and nobody back since is how a condition
 * becomes an emergency and a "we told them repeatedly" becomes indefensible.
 * Sorting by age within OPEN puts the stalled ones where they are seen.
 */
export async function listViolationCases(scope: ResolvedScope): Promise<CaseSummary[]> {
  if (scope.propertyIds.length === 0) return []
  const rows = await prisma.violationCase.findMany({
    where: { propertyId: { in: scope.propertyIds } },
    orderBy: [{ status: 'asc' }, { openedAt: 'asc' }],
    select: {
      id: true,
      kind: true,
      status: true,
      outcome: true,
      leaseId: true,
      openedAt: true,
      property: { select: { name: true } },
      unit: { select: { name: true } },
      lease: {
        select: {
          leaseTenants: { select: { tenant: { select: { firstName: true, lastName: true } } } },
        },
      },
      observations: { select: { observedOn: true }, orderBy: { observedOn: 'desc' }, take: 1 },
      _count: { select: { observations: true } },
      accommodationRequests: {
        where: { status: { in: ['RECEIVED', 'INFO_REQUESTED'] } },
        select: { id: true },
      },
    },
  })

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as ViolationKind,
    status: row.status as ViolationStatus,
    outcome: row.outcome as ViolationOutcome | null,
    propertyName: row.property.name,
    unitLabel: row.unit.name,
    leaseId: row.leaseId,
    tenantNames: row.lease.leaseTenants.map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`),
    openedAt: row.openedAt,
    observationCount: row._count.observations,
    lastObservedOn: row.observations[0] ? utcToBusinessDate(row.observations[0].observedOn) : null,
    openAccommodationCount: row.accommodationRequests.length,
  }))
}

/**
 * The cases on one tenancy, for the lease page's panel. Unscoped like
 * `abandonment`'s equivalent: the caller has already proved its access to the
 * lease, and re-deriving scope here would be a second answer to a question
 * already settled one frame up.
 */
export async function casesForLease(leaseId: string): Promise<LeaseCaseSummary[]> {
  const rows = await prisma.violationCase.findMany({
    where: { leaseId },
    orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
    select: {
      id: true,
      kind: true,
      status: true,
      outcome: true,
      openedAt: true,
      _count: { select: { observations: true } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as ViolationKind,
    status: row.status as ViolationStatus,
    outcome: row.outcome as ViolationOutcome | null,
    openedAt: row.openedAt,
    observationCount: row._count.observations,
  }))
}

export interface LeaseCaseSummary {
  id: string
  kind: ViolationKind
  status: ViolationStatus
  outcome: ViolationOutcome | null
  openedAt: Date
  observationCount: number
}

/**
 * The two facts `animalCaseFork` and `validateClosure` turn on.
 *
 * Read together in one place because they are asked together at every
 * decision point, and because "is there an undecided request" is exactly the
 * question somebody skips when it lives on a different screen.
 */
export async function accommodationPosture(leaseId: string): Promise<{
  hasApprovedAssistanceAnimal: boolean
  hasUndecidedRequest: boolean
  approvedAccommodationId: string | null
}> {
  const rows = await prisma.accommodationRequest.findMany({
    where: { leaseId },
    select: { id: true, kind: true, status: true },
  })
  const approved = rows.find((r) => r.status === 'APPROVED')
  return {
    hasApprovedAssistanceAnimal: rows.some(
      (r) => r.status === 'APPROVED' && r.kind !== 'POLICY_EXCEPTION',
    ),
    hasUndecidedRequest: rows.some(
      (r) => r.status === 'RECEIVED' || r.status === 'INFO_REQUESTED',
    ),
    approvedAccommodationId: approved?.id ?? null,
  }
}
