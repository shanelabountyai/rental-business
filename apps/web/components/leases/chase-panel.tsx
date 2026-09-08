import { friendlyBusinessDate } from '@rental/core/scheduling'
import type { ChaseHistoryRow } from '@/lib/payments/chase-history.ts'

// What the rent chase sent to this tenancy, and to whom (PAY-06; R-179).
//
// READ-ONLY. The press itself lives on the rent roll, where the server-side
// grace re-check is — a "chase them" button here would be a second send path
// with a second set of guards, which is the duplication `pastGraceLeaseIds`
// exists to prevent.
//
// EVERY ROW, INCLUDING THE ONES THAT WERE NOT SENT. A suppressed delivery is
// the answer to "why didn't the guarantor get it", and hiding it would leave
// the panel saying the chase reached everybody when it reached two of three.

export function ChasePanel({ rows }: { rows: ChaseHistoryRow[] }) {
  return (
    <section aria-labelledby="chase-history" className="flex flex-col gap-4 rounded-md border p-4">
      <h2 id="chase-history" className="text-sm font-semibold">
        Rent chase history
      </h2>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nobody on this tenancy has been sent a rent reminder. The chase is
          sent from the rent roll, and only once the statutory grace period
          has run out.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-0.5 border-b pb-2 last:border-b-0 last:pb-0">
              <span className="text-sm font-medium">
                {row.who} <span className="text-muted-foreground font-normal">({row.role})</span>
              </span>
              <span className="text-muted-foreground text-xs">
                {/* Formatted HERE, from a raw `BusinessDate` (D-153/D-154). A
                    tenant-facing trail that prints `2026-08-01` is the defect
                    that shipped in an email template for months. */}
                {friendlyBusinessDate(row.onDate)} · {row.channel.toLowerCase()} · {row.toAddress}
              </span>
              <span className="text-xs">{row.outcome}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
