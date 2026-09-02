import 'server-only'

import { type ScraLookupResult as CoreLookupResult } from '@rental/core/scra'
import { utcToBusinessDate } from '@rental/core/scheduling'
import { type ScraLookupResult, prisma } from '@rental/db'

// Reading DMDC military-service searches (RISK-12, R-085).

/// Prisma's enum is SCREAMING_CASE; core's vocabulary is the lowercase one
/// the statute references and the UI uses. Two maps rather than one shared
/// string, for the same reason lib/holds/queries.ts carries a pair: core
/// must not import the Prisma client, and the database must not hold
/// lowercase enum labels.
const TO_CORE: Record<ScraLookupResult, CoreLookupResult> = {
  IN_SERVICE: 'in_service',
  NOT_IN_SERVICE: 'not_in_service',
  INDETERMINATE: 'indeterminate',
}

const TO_DB: Record<CoreLookupResult, ScraLookupResult> = {
  in_service: 'IN_SERVICE',
  not_in_service: 'NOT_IN_SERVICE',
  indeterminate: 'INDETERMINATE',
}

export function toDbLookupResult(value: CoreLookupResult): ScraLookupResult {
  return TO_DB[value]
}

export interface LookupView {
  id: string
  tenantId: string
  tenantName: string
  result: CoreLookupResult
  /// A calendar day, read with `utcToBusinessDate` and never through a
  /// timezone — it is a `@db.Date` (CLAUDE.md's own rule on this column
  /// type, and the defect R-042 shipped by getting it wrong).
  searchedOn: string
  providerReference: string | null
  activeDutyStartOn: string | null
  activeDutyEndOn: string | null
  certificateDocumentId: string | null
  certificateFileName: string | null
  recordedByName: string
  notes: string | null
}

const LOOKUP_SELECT = {
  id: true,
  tenantId: true,
  result: true,
  searchedOn: true,
  providerReference: true,
  activeDutyStartOn: true,
  activeDutyEndOn: true,
  certificateDocumentId: true,
  notes: true,
  tenant: { select: { firstName: true, lastName: true } },
  certificate: { select: { fileName: true } },
  recordedBy: { select: { name: true } },
} as const

function toView(row: {
  id: string
  tenantId: string
  result: ScraLookupResult
  searchedOn: Date
  providerReference: string | null
  activeDutyStartOn: Date | null
  activeDutyEndOn: Date | null
  certificateDocumentId: string | null
  notes: string | null
  tenant: { firstName: string; lastName: string }
  certificate: { fileName: string } | null
  recordedBy: { name: string }
}): LookupView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantName: `${row.tenant.firstName} ${row.tenant.lastName}`,
    result: TO_CORE[row.result],
    searchedOn: utcToBusinessDate(row.searchedOn),
    providerReference: row.providerReference,
    activeDutyStartOn: row.activeDutyStartOn ? utcToBusinessDate(row.activeDutyStartOn) : null,
    activeDutyEndOn: row.activeDutyEndOn ? utcToBusinessDate(row.activeDutyEndOn) : null,
    certificateDocumentId: row.certificateDocumentId,
    certificateFileName: row.certificate?.fileName ?? null,
    recordedByName: row.recordedBy.name,
    notes: row.notes,
  }
}

/**
 * Every search recorded against a tenancy, newest first.
 *
 * All of them, not just the latest: a tenancy accumulates searches - one
 * when the case opens, another before the hearing because the first went
 * stale - and each is evidence as of its own date. "What did you know in
 * March" is answerable only from the March row.
 */
export async function lookupsForLease(leaseId: string): Promise<LookupView[]> {
  const rows = await prisma.scraLookup.findMany({
    where: { leaseId },
    select: LOOKUP_SELECT,
    orderBy: [{ searchedOn: 'desc' }, { recordedAt: 'desc' }],
  })
  return rows.map(toView)
}

/**
 * The most recent search on a tenancy — what `affidavitReadiness` reads.
 *
 * ==========================================================================
 * THE WORST RESULT AMONG THE MOST RECENT SEARCHES WINS, NOT THE NEWEST ROW.
 *
 * A two-adult tenancy needs a search per adult (§3931 is about a named
 * defendant), and the ones that matter are each tenant's own latest. If one
 * of them comes back IN_SERVICE and the other, searched a day later, comes
 * back NOT_IN_SERVICE, the honest answer for the case is IN_SERVICE — taking
 * the newest row alone would let a second defendant's clean result mask the
 * first's protection, which is precisely the mistake §3931 exists to
 * prevent.
 *
 * `INDETERMINATE` outranks `NOT_IN_SERVICE` for the same reason: a no-match
 * is not a negative, and the affidavit must not be sworn as though it were.
 * ==========================================================================
 */
export async function affidavitLookupFor(
  leaseId: string,
): Promise<{ result: CoreLookupResult; searchedOn: string } | null> {
  const rows = await prisma.scraLookup.findMany({
    where: { leaseId },
    select: { tenantId: true, result: true, searchedOn: true },
    orderBy: [{ searchedOn: 'desc' }, { recordedAt: 'desc' }],
  })
  if (rows.length === 0) return null

  const latestPerTenant = new Map<string, { result: ScraLookupResult; searchedOn: Date }>()
  for (const row of rows) {
    // Already ordered newest-first, so the first sighting of a tenant is
    // their latest search.
    if (!latestPerTenant.has(row.tenantId)) {
      latestPerTenant.set(row.tenantId, { result: row.result, searchedOn: row.searchedOn })
    }
  }

  const ranked: ScraLookupResult[] = ['IN_SERVICE', 'INDETERMINATE', 'NOT_IN_SERVICE']
  const candidates = [...latestPerTenant.values()]
  const worst = ranked.find((result) => candidates.some((row) => row.result === result))!
  const matching = candidates.filter((row) => row.result === worst)

  // The OLDEST of the rows carrying the deciding result, so staleness is
  // measured against the weakest evidence rather than flattered by a newer
  // search that says something else.
  const searchedOn = matching.reduce(
    (oldest, row) => (row.searchedOn < oldest ? row.searchedOn : oldest),
    matching[0]!.searchedOn,
  )

  return { result: TO_CORE[worst], searchedOn: utcToBusinessDate(searchedOn) }
}
