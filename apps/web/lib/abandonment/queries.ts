import 'server-only'

import type {
  AbandonmentOutcome,
  AbandonmentStatus,
  ContactMethod,
  ContactOutcome,
} from '@rental/core/abandonment'
import { utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/types.ts'

// Reading abandonment case files (RISK-01, R-087).

export interface AttemptView {
  id: string
  method: ContactMethod
  outcome: ContactOutcome
  attemptedOn: string
  note: string | null
  recordedByName: string
}

export interface CaseView {
  id: string
  propertyId: string
  leaseId: string
  status: AbandonmentStatus
  outcome: AbandonmentOutcome | null
  outcomeNote: string | null
  propertyName: string
  unitName: string
  timezone: string
  state: string
  county: string | null
  tenantNames: string[]
  openedByName: string
  openedAt: Date
  lastContactOn: string | null
  enteredAt: Date | null
  entryFindings: string | null
  entryNoticeId: string | null
  belongingsHeldFrom: string | null
  belongingsInventory: string | null
  belongingsNoticeSentOn: string | null
  belongingsDisposedAt: Date | null
  attempts: AttemptView[]
  documents: { id: string; fileName: string }[]
}

const CASE_INCLUDE = {
  property: { select: { name: true, timezone: true, state: true, county: true } },
  unit: { select: { name: true } },
  lease: {
    select: {
      leaseTenants: {
        orderBy: { isPrimary: 'desc' as const },
        select: { tenant: { select: { firstName: true, lastName: true } } },
      },
    },
  },
  openedBy: { select: { name: true } },
  attempts: {
    orderBy: { attemptedOn: 'desc' as const },
    include: { recordedBy: { select: { name: true } } },
  },
  documents: { select: { id: true, fileName: true } },
} as const

type Row = Awaited<ReturnType<typeof fetchCase>>

async function fetchCase(id: string) {
  return prisma.abandonmentCase.findUnique({ where: { id }, include: CASE_INCLUDE })
}

function toView(row: NonNullable<Row>): CaseView {
  return {
    id: row.id,
    propertyId: row.propertyId,
    leaseId: row.leaseId,
    status: row.status as AbandonmentStatus,
    outcome: (row.outcome as AbandonmentOutcome | null) ?? null,
    outcomeNote: row.outcomeNote,
    propertyName: row.property.name,
    unitName: row.unit.name,
    timezone: row.property.timezone,
    state: row.property.state,
    county: row.property.county,
    tenantNames: row.lease.leaseTenants.map(
      (lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`,
    ),
    openedByName: row.openedBy.name,
    openedAt: row.openedAt,
    // Every one of these is a `@db.Date`, so `utcToBusinessDate` — a
    // calendar day never goes through a timezone (CLAUDE.md's own rule, and
    // the defect R-042 shipped by breaking it).
    lastContactOn: row.lastContactOn ? utcToBusinessDate(row.lastContactOn) : null,
    enteredAt: row.enteredAt,
    entryFindings: row.entryFindings,
    entryNoticeId: row.entryNoticeId,
    belongingsHeldFrom: row.belongingsHeldFrom
      ? utcToBusinessDate(row.belongingsHeldFrom)
      : null,
    belongingsInventory: row.belongingsInventory,
    belongingsNoticeSentOn: row.belongingsNoticeSentOn
      ? utcToBusinessDate(row.belongingsNoticeSentOn)
      : null,
    belongingsDisposedAt: row.belongingsDisposedAt,
    attempts: row.attempts.map((attempt) => ({
      id: attempt.id,
      method: attempt.method as ContactMethod,
      outcome: attempt.outcome as ContactOutcome,
      attemptedOn: utcToBusinessDate(attempt.attemptedOn),
      note: attempt.note,
      recordedByName: attempt.recordedBy.name,
    })),
    documents: row.documents,
  }
}

/// One case, scoped. Returns null rather than throwing for anything outside
/// the caller's scope, so the page answers 404 rather than 403 (ROLE-01).
export async function getAbandonmentCase(
  id: string,
  scope: ResolvedScope,
): Promise<CaseView | null> {
  if (scope.propertyIds.length === 0) return null
  const row = await fetchCase(id)
  if (!row || !scope.propertyIds.includes(row.propertyId)) return null
  return toView(row)
}

export async function listAbandonmentCases(scope: ResolvedScope): Promise<CaseView[]> {
  if (scope.propertyIds.length === 0) return []
  const rows = await prisma.abandonmentCase.findMany({
    where: { propertyId: { in: scope.propertyIds } },
    include: CASE_INCLUDE,
    // Open cases first — a closed one is a record, an open one is somebody
    // nobody has found yet.
    orderBy: [{ closedAt: { sort: 'asc', nulls: 'first' } }, { openedAt: 'desc' }],
  })
  return rows.map(toView)
}

export async function casesForLease(leaseId: string): Promise<CaseView[]> {
  const rows = await prisma.abandonmentCase.findMany({
    where: { leaseId },
    include: CASE_INCLUDE,
    orderBy: [{ closedAt: { sort: 'asc', nulls: 'first' } }, { openedAt: 'desc' }],
  })
  return rows.map(toView)
}

// `daysSinceContact` lived here until R-200 and is deliberately gone rather
// than moved. Its own comment warned that "getting this wrong shortens a
// statutory clock", and a plain millisecond subtraction was exactly that
// once a state counts in business days. `assessEvidence` now takes the two
// dates and counts them on the jurisdiction's basis, so there is nothing
// left for a caller here to precompute - and nothing left to precompute
// WRONGLY, which is the point of deleting it rather than leaving it beside
// the thing that replaced it.
