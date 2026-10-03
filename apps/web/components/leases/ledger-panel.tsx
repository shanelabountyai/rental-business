import { formatCents } from '@rental/core/money'
import { Panel } from '@/components/panel.tsx'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

// The tenant ledger (PAY-03, PAY-09, D-11).
//
// A server component: numbers and text, no state.
//
// WRITTEN TO BE READ BY A JUDGE. PAY-09 asks for the statement
// "chronological, plain language, no cryptic codes - a judge has to read
// it", and that shapes every choice here: entry types are rendered as
// English, a reversal says what it reverses rather than showing a negative
// somebody has to interpret, and the running balance is on every line so the
// story reads forwards instead of having to be reconstructed.
//
// Nothing here is editable. Under D-11 this is a projection of Stripe, and a
// screen offering to change it would be offering something the product
// cannot honour.

const TYPE_LABELS: Record<string, string> = {
  CHARGE: 'Charged',
  PAYMENT: 'Paid',
  CREDIT: 'Credit',
  REVERSAL: 'Reversed',
  ADJUSTMENT: 'Adjustment',
}

export interface LedgerLineView {
  id: string
  type: string
  amountCents: number
  occurredAt: string
  description: string
  runningBalanceCents: number
  reversed: boolean
}

export function LedgerPanel({
  lines,
  balanceCents,
}: {
  lines: readonly LedgerLineView[]
  balanceCents: number
}) {
  return (
    <Panel
      headingId="ledger"
      title="Ledger"
      trailing={
        <span className="text-sm">
          {balanceCents === 0
            ? 'Nothing owed'
            : balanceCents > 0
              ? `${formatCents(balanceCents)} owed`
              : /*
                  A credit balance is a real state - an overpayment, a
                  concession - and saying "−$50 owed" would read as a
                  debt. It is the tenant's money.
                */
                `${formatCents(-balanceCents)} in credit`}
        </span>
      }
    >

      {lines.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing posted yet. Charges and payments appear here as Stripe reports
          them.
        </p>
      ) : (
        // UX-09: below `sm` this is a stack of cards, not a sideways-scrolling
        // table — the only way to see Balance on a 412px phone without
        // scrolling. Table/row/cell roles are set EXPLICITLY because Chromium
        // derives them from computed `display` otherwise, and `flex` on the
        // mobile `<td>`/`<tr>` would silently drop them below `sm` (axe and
        // `getByRole('cell'/'row', …)` both rely on the role being there).
        <div className="sm:overflow-x-auto" {...scrollableRegionProps('Tenancy ledger, scrolls sideways')}>
          <table role="table" className="block w-full text-sm sm:table">
            <caption className="sr-only">
              Every charge and payment on this tenancy, oldest first, with the
              balance after each.
            </caption>
            <thead className="hidden sm:table-header-group">
              <tr className="text-muted-foreground text-left text-xs">
                <th scope="col" className="py-1 pr-3 font-medium">Date</th>
                <th scope="col" className="py-1 pr-3 font-medium">What</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Amount</th>
                <th scope="col" className="py-1 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="flex flex-col gap-3 sm:table-row-group sm:gap-0 sm:divide-y">
              {lines.map((line) => (
                <tr
                  key={line.id}
                  role="row"
                  className={`flex flex-col gap-1 rounded-md border p-3 sm:table-row sm:gap-0 sm:rounded-none sm:border-0 sm:p-0 ${line.reversed ? 'text-muted-foreground' : ''}`}
                >
                  <td role="cell" className="flex flex-col gap-0.5 py-1 sm:table-cell sm:py-2 sm:pr-3 sm:align-top sm:whitespace-nowrap">
                    <span className="text-muted-foreground text-xs font-medium sm:hidden">Date</span>
                    <span>{line.occurredAt}</span>
                  </td>
                  <td role="cell" className="flex flex-col gap-0.5 py-1 sm:table-cell sm:py-2 sm:pr-3 sm:align-top">
                    <span className="text-muted-foreground text-xs font-medium sm:hidden">What</span>
                    <span>
                      {TYPE_LABELS[line.type] ?? line.type}
                      {' — '}
                      {line.description}
                      {line.reversed && ' (later reversed)'}
                    </span>
                  </td>
                  <td role="cell" className="flex flex-col gap-0.5 py-1 sm:table-cell sm:py-2 sm:pr-3 sm:text-right sm:align-top sm:whitespace-nowrap">
                    <span className="text-muted-foreground text-xs font-medium sm:hidden">Amount</span>
                    <span>{formatCents(line.amountCents)}</span>
                  </td>
                  <td role="cell" className="flex flex-col gap-0.5 py-1 sm:table-cell sm:py-2 sm:text-right sm:align-top sm:whitespace-nowrap">
                    <span className="text-muted-foreground text-xs font-medium sm:hidden">Balance</span>
                    <span>{formatCents(line.runningBalanceCents)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Built from what Stripe reports, never written directly (D-11). A
        correction is a new reversing entry — nothing here is edited or
        deleted.
      </p>
    </Panel>
  )
}
