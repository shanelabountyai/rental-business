import { formatCents } from '@rental/core/money'
import type { WaiverPatternRow } from '@/lib/ledger/waiver-report.ts'

// PAY-04's waiver-pattern report (D-34, R-041).
//
// A server component: numbers and text, no state.
//
// THIS REPORTS A PATTERN AND NEVER A VERDICT, and the wording works hard at
// that distinction. An uneven distribution of waived fees has plenty of
// lawful explanations — a long-standing tenant with one bad month is not the
// same case as a new one who has never paid on time. What it must not be is
// invisible, because waiving fees for some tenants and not others, along
// lines that happen to correlate with a protected class, is a discrimination
// pattern regardless of anybody's intent.
//
// It deliberately lists tenants with NO waivers alongside those with many.
// A report of waivers alone would show only generosity and hide its
// distribution — the tenants who were never forgiven anything are half the
// pattern, and the half an operator is least likely to think about.

export function WaiverPattern({ rows }: { rows: readonly WaiverPatternRow[] }) {
  return (
    <section aria-labelledby="waiver-pattern" className="flex flex-col gap-3 border-t pt-6">
      <div className="flex flex-col gap-1">
        <h2 id="waiver-pattern" className="text-lg font-semibold">
          Fee waivers by tenant
        </h2>
        <p className="text-muted-foreground text-sm">
          Every tenant who has been charged a late or returned-payment fee, and
          how much of it was forgiven. Shown because uneven waiving is a
          fair-housing risk whatever the intent behind it — not because any
          particular row is wrong.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No fees have been charged yet, so there is no pattern to show.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Fees assessed and waived per tenant, most-forgiven first.
            </caption>
            <thead>
              <tr className="text-muted-foreground text-left text-xs">
                <th scope="col" className="py-1 pr-3 font-medium">Tenant</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Fees charged</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Charged</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Waived</th>
                <th scope="col" className="py-1 text-right font-medium">Share waived</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.tenantId}>
                  <td className="py-2 pr-3 align-top">{row.tenantName}</td>
                  <td className="py-2 pr-3 text-right align-top">
                    {row.feesWaived} of {row.feesAssessed}
                  </td>
                  <td className="py-2 pr-3 text-right align-top whitespace-nowrap">
                    {formatCents(row.assessedCents)}
                  </td>
                  <td className="py-2 pr-3 text-right align-top whitespace-nowrap">
                    {formatCents(row.waivedCents)}
                  </td>
                  <td className="py-2 text-right align-top whitespace-nowrap">
                    {/* Rounded to whole percent. False precision on a number
                        meant to prompt a question rather than answer one. */}
                    {Math.round(row.waivedShare * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        A tenant at 100% beside a tenant at 0% is worth understanding, not
        worth assuming about. Every waiver carries the reason somebody gave for
        it, on the lease it belongs to.
      </p>
    </section>
  )
}
