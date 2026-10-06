import { formatCents } from '@rental/core/money'
import { friendlyDate } from '@rental/core/scheduling'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

// The tenant's and the guarantor's statement, newest first. One component
// because the two pages carried the same table line for line.
//
// Below `sm` this is a stack of cards, not a sideways-scrolling table (the
// UX-09 pattern from `rent-roll-table.tsx`): the reader is on a phone, and
// "Owed after" is the column they came for. Table/row/cell roles are set
// EXPLICITLY because Chromium derives them from computed `display`, and
// `flex` on the mobile `<tr>`/`<td>` would silently drop them.
export function StatementTable({
  lines,
  reversed,
  timezone,
  label,
  caption,
}: {
  lines: readonly {
    id: string
    occurredAt: Date
    description: string
    amountCents: number
    runningBalanceCents: number
  }[]
  reversed: ReadonlySet<string>
  timezone: string
  label: string
  caption: string
}) {
  const cell = 'flex items-baseline justify-between gap-3 sm:table-cell sm:py-2'
  const cellLabel = 'text-muted-foreground text-xs font-medium sm:hidden'
  return (
    <div className="sm:overflow-x-auto" {...scrollableRegionProps(label)}>
      <table role="table" className="block w-full text-sm sm:table">
        <caption className="sr-only">{caption}</caption>
        <thead className="hidden sm:table-header-group">
          <tr className="text-muted-foreground border-b text-left text-xs">
            <th scope="col" className="py-2 pr-3 font-medium">
              When
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              What
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Amount
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Owed after
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup" className="flex flex-col gap-3 sm:table-row-group">
          {/* Reversed for display only. The running balance was computed
              oldest-first in core, so the number beside a line is the balance
              after that line, whichever order it is displayed in. */}
          {[...lines].reverse().map((line) => {
            const isPayment = line.amountCents < 0
            return (
              <tr
                key={line.id}
                role="row"
                className="flex flex-col gap-1 rounded-md border p-3 sm:table-row sm:rounded-none sm:border-0 sm:border-b sm:p-0 sm:last:border-0"
              >
                <td role="cell" className={`${cell} sm:pr-3 sm:whitespace-nowrap`}>
                  <span className={cellLabel}>When</span>
                  {/* The PROPERTY's clock, not the server's (R-101c). */}
                  {friendlyDate(line.occurredAt, timezone)}
                </td>
                <td role="cell" className={`${cell} break-words sm:pr-3`}>
                  <span className={cellLabel}>What</span>
                  <span className="min-w-0 text-right sm:text-left">
                    {/* Its own element, so the description is addressable on
                        its own; the reversal note shares this cell. */}
                    <span>{line.description}</span>
                    {reversed.has(line.id) && (
                      // Said plainly rather than hidden. D-11 keeps the
                      // original row visible and adds a reversal beside it; a
                      // tenant who sees a payment listed and then reversed
                      // needs to know which it was, or the statement looks
                      // like it double-counted.
                      <span className="text-muted-foreground block text-xs">
                        This was later reversed
                      </span>
                    )}
                  </span>
                </td>
                <td
                  role="cell"
                  className={`${cell} tabular-nums sm:pr-3 sm:text-right sm:whitespace-nowrap ${
                    isPayment ? 'text-success' : ''
                  }`}
                >
                  <span className={cellLabel}>Amount</span>
                  {/* A payment reduces what is owed, so it shows as a minus.
                      The sign is how a tenant tells "you charged me" from "I
                      paid you" at a glance. */}
                  <span>
                    {isPayment ? '−' : ''}
                    {formatCents(Math.abs(line.amountCents))}
                  </span>
                </td>
                <td role="cell" className={`${cell} tabular-nums sm:text-right sm:whitespace-nowrap`}>
                  <span className={cellLabel}>Owed after</span>
                  {formatCents(Math.max(0, line.runningBalanceCents))}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
