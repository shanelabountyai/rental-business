import { toCsv } from '@rental/core/ledger'
import { requireScope } from '@/lib/auth/guard.ts'
import { orgAuditFilters, orgAuditRows, orgAuditWhere } from '@/lib/audit/org-log.ts'
import { orgTimezone } from '@/lib/support/grants.ts'

// `/settings/audit`'s rows as a file (PRD 11 §4.15, R-295b): the same scope,
// filters and permission as the page. Every field goes through `toCsv`'s
// injection guard.

// ponytail: one read capped at 50k rows, as the console's export is; stream
// it if an org's log outgrows that.
const MAX_ROWS = 50_000

export async function GET(request: Request) {
  const { actor, scope } = await requireScope('audit.read')
  const filters = orgAuditFilters(Object.fromEntries(new URL(request.url).searchParams))
  const where = orgAuditWhere(actor, scope, filters, await orgTimezone(actor.orgId))
  const rows = where ? await orgAuditRows(where, MAX_ROWS) : []
  const csv = toCsv(
    ['Occurred at (UTC)', 'Who', 'Action', 'Property', 'Entity type', 'Entity id', 'Reason', 'Support grant'],
    rows.map((r) => [
      r.occurredAt.toISOString(),
      r.who,
      r.action,
      r.property?.name,
      r.entityType,
      r.entityId,
      r.reason,
      r.supportGrantId,
    ]),
  )
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="audit-log.csv"',
      'cache-control': 'no-store',
    },
  })
}
