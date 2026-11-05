import { toCsv } from '@rental/core/ledger'
import { parseQuarter } from '@rental/core/screening'
import { requirePermission } from '@/lib/auth/guard.ts'
import { decisionsInQuarter } from '@/lib/screening/criteria-queries.ts'

// The adverse-action report as a file (R-297, PRD 10 §7.1): one row per
// decision, so counsel can pivot it however the inquiry asks. Same
// permission as the page; every field goes through toCsv's injection guard.
export async function GET(request: Request) {
  const actor = await requirePermission('screening.criteria.write')
  const quarter = parseQuarter(new URL(request.url).searchParams.get('quarter') ?? '')
  if (!quarter) return new Response('Name a quarter, for example 2026-Q4.', { status: 400 })

  const rows = await decisionsInQuarter(actor.orgId, quarter)
  const csv = toCsv(
    ['Decided on', 'Property', 'Outcome', 'Reason code', 'Reason', 'Application completed on'],
    rows.map((r) => [r.decidedOn, r.propertyName, r.decision, r.reasonCode, r.reasonLabel, r.completedOn]),
  )
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="adverse-action-${quarter.label}.csv"`,
    },
  })
}
