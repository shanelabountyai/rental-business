import 'server-only'

import { utcToBusinessDate } from '@rental/core/scheduling'
import type { AnimalKind, RequestStatus } from '@rental/core/accommodations'
import { prisma } from '@rental/db'

// Reading assistance-animal accommodation requests (RISK-13, R-086).

export interface RequestView {
  id: string
  kind: AnimalKind
  status: RequestStatus
  requesterName: string
  requestText: string
  animalDescription: string | null
  disabilityObservable: boolean
  needObservable: boolean
  /// Calendar days, read with `utcToBusinessDate` — the clock is measured in
  /// them and no timezone may touch one.
  receivedOn: string
  infoRequestedOn: string | null
  decidedOn: string | null
  determinationText: string | null
  decidedByName: string | null
  documents: { id: string; fileName: string }[]
}

const SELECT = {
  id: true,
  kind: true,
  status: true,
  requestText: true,
  animalDescription: true,
  disabilityObservable: true,
  needObservable: true,
  receivedOn: true,
  infoRequestedOn: true,
  decidedOn: true,
  determinationText: true,
  requestedByName: true,
  tenant: { select: { firstName: true, lastName: true } },
  decidedBy: { select: { name: true } },
  documents: { select: { id: true, fileName: true } },
} as const

export async function requestsForLease(leaseId: string): Promise<RequestView[]> {
  const rows = await prisma.accommodationRequest.findMany({
    where: { leaseId },
    select: SELECT,
    orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }],
  })

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as AnimalKind,
    status: row.status as RequestStatus,
    requesterName: row.tenant
      ? `${row.tenant.firstName} ${row.tenant.lastName}`
      : (row.requestedByName ?? 'Not recorded'),
    requestText: row.requestText,
    animalDescription: row.animalDescription,
    disabilityObservable: row.disabilityObservable,
    needObservable: row.needObservable,
    receivedOn: utcToBusinessDate(row.receivedOn),
    infoRequestedOn: row.infoRequestedOn ? utcToBusinessDate(row.infoRequestedOn) : null,
    decidedOn: row.decidedOn ? utcToBusinessDate(row.decidedOn) : null,
    determinationText: row.determinationText,
    decidedByName: row.decidedBy?.name ?? null,
    documents: row.documents,
  }))
}

/**
 * Whether this tenancy has an approved assistance animal — the one fact
 * `petMoneyAllowed` needs.
 *
 * ==========================================================================
 * ITS OWN NARROW QUERY, CALLED FROM THE MONEY PATH.
 *
 * Not "load the requests and look at them": the callers are charge writers
 * that have no other reason to know this table exists, and the cheapest
 * correct question is a count. Keeping it to one exported function is also
 * what makes the rule greppable — every pet-money writer in this product is
 * a caller of this and of `petMoneyAllowed`, and there is nowhere else to
 * put the check by accident.
 * ==========================================================================
 */
export async function hasApprovedAssistanceAnimal(leaseId: string): Promise<boolean> {
  const count = await prisma.accommodationRequest.count({
    where: { leaseId, status: 'APPROVED' },
  })
  return count > 0
}

/** The same question for many leases at once, for a sweep or a list. */
export async function leasesWithApprovedAssistanceAnimal(
  leaseIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (leaseIds.length === 0) return new Set()
  const rows = await prisma.accommodationRequest.findMany({
    where: { leaseId: { in: [...leaseIds] }, status: 'APPROVED' },
    select: { leaseId: true },
    distinct: ['leaseId'],
  })
  return new Set(rows.map((row) => row.leaseId))
}
