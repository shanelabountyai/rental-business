import { csvCents, toCsv } from '@rental/core/ledger'
import type { BusinessDate } from '@rental/core/scheduling'
import { requireScope } from '@/lib/auth/guard.ts'
import { settlementReport } from '@/lib/reports/settlement.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { reportToday } from '@/lib/scope/report-today.ts'

// The settlement report as a file (R-180). The audience is a bookkeeper
// matching this against a bank statement, which is why the payment rows go
// out rather than the entity totals alone - a total nobody can take apart is
// a total nobody can reconcile.
//
// Money is a bare number so a spreadsheet can sum it, and every field goes
// through `toCsv`'s injection guard, for the reasons the rent-roll route
// gives at length.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export async function GET(request: Request) {
  // Same permission as the screen. An export is a read of the same data.
  const { actor } = await requireScope('report.financial')
  const scope = await currentScope(actor)

  const url = new URL(request.url)
  const today = reportToday(scope, new Date())
  const rawFrom = url.searchParams.get('from')
  const rawTo = url.searchParams.get('to')
  const from = (rawFrom && DATE_PATTERN.test(rawFrom) ? rawFrom : `${today.slice(0, 7)}-01`) as BusinessDate
  const to = (rawTo && DATE_PATTERN.test(rawTo) ? rawTo : today) as BusinessDate
  const [start, end] = from <= to ? [from, to] : [to, from]

  const report = await settlementReport(scope, start, end)

  const csv = toCsv(
    ['Settled on', 'Legal entity', 'Property', 'Unit', 'Payer', 'Channel', 'Amount', 'Returned on'],
    report.rows.map((row) => [
      // A `BusinessDate` is a calendar day and stays one in a file a
      // spreadsheet will parse - formatting it here would make it text.
      row.settledOn,
      row.entityName,
      row.propertyName,
      row.unitName ?? '',
      row.payerName,
      row.channel,
      csvCents(row.amountCents),
      row.reversedOn ?? '',
    ]),
  )

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="settlement-${start}-to-${end}.csv"`,
      // A settlement report is a point-in-time financial statement; a cached
      // one reconciled against a bank line is worse than none.
      'cache-control': 'no-store',
    },
  })
}
