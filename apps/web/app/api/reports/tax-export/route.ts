import { csvCents, toCsv } from '@rental/core/ledger'
import { TAX_EXPORT_CSV_HEADERS, isAccountingBasis } from '@rental/core/tax'
import { requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { exportableEntities, taxExportFacts } from '@/lib/tax/queries.ts'

// RPT-03 (R-078): the year-end export as a file.
//
// A route handler rather than a server action: the response IS the file, and
// an action cannot set Content-Disposition. Same shape as the rent-roll
// route, and the same permission as the screen it hangs off.

export async function GET(request: Request) {
  const { actor } = await requireScope('report.financial')
  const scope = await currentScope(actor)

  const params = new URL(request.url).searchParams
  const entities = exportableEntities(scope)
  const entityId = params.get('entity') ?? entities[0]?.id
  const year = Number(params.get('year')) || new Date().getUTCFullYear() - 1
  const basisParam = params.get('basis') ?? 'cash'
  const basis = isAccountingBasis(basisParam) ? basisParam : 'cash'

  // `taxExportFacts` intersects the entity with the actor's own scope and
  // answers null when nothing survives - so a hand-typed entity id belonging
  // to somebody else's portfolio gets 404, not 403 (ROLE-01: "forbidden"
  // would confirm the record exists).
  const report = entityId ? await taxExportFacts(scope, entityId, year, basis) : null
  if (!report) return new Response('Not found', { status: 404 })

  // Exceptions come LAST, and they are in the same file rather than a second
  // download: RPT-03's "nothing silently dropped" only holds if the reader
  // cannot come away with the mapped rows and no idea the others existed.
  const rows = [...report.lines, ...report.exceptions].map((line) => [
    line.section,
    line.bookedOn ?? '',
    line.propertyName,
    line.scheduleELine ?? '',
    line.scheduleELabel,
    line.quickBooksAccount,
    line.description,
    csvCents(line.amountCents),
    line.sourceKind,
    line.sourceId,
    line.reason ?? '',
  ])

  const csv = toCsv([...TAX_EXPORT_CSV_HEADERS], rows)
  const slug = report.legalEntityName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="tax-export-${slug}-${report.year}-${report.basis}.csv"`,
      // A stale year-end export handed to an accountant is worse than none.
      'cache-control': 'no-store',
    },
  })
}
