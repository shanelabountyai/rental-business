import { toCsv } from '@rental/core/ledger'
import { requirePlatform } from '@/lib/platform/guard.ts'
import { auditFilters, platformAuditRows } from '@/lib/platform/audit.ts'

// `/platform/audit`'s rows as a file (PRD 11 §4.9, R-303b): the same filters
// and permission as the page. A route handler because the response IS the
// file. Every field goes through `toCsv`'s injection guard.

// ponytail: one read capped at 50k rows; stream it if the log outgrows that.
const MAX_ROWS = 50_000

export async function GET(request: Request) {
  await requirePlatform({ permission: 'platformAudit.read' })
  const filters = auditFilters(Object.fromEntries(new URL(request.url).searchParams))
  const rows = await platformAuditRows(filters, MAX_ROWS)
  const csv = toCsv(
    ['Occurred at (UTC)', 'Admin', 'Admin email', 'Action', 'Organisation', 'Entity type', 'Entity id', 'Reason'],
    rows.map((r) => [
      r.occurredAt.toISOString(),
      r.admin?.name ?? r.actorRef,
      r.admin?.email,
      r.action,
      r.organization?.slug,
      r.entityType,
      r.entityId,
      r.reason,
    ]),
  )
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="platform-audit.csv"',
      'cache-control': 'no-store',
    },
  })
}
