import { formatCents } from '@rental/core/money'

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
    <section aria-labelledby="ledger" className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ledger" className="text-lg font-semibold">
          Ledger
        </h2>
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
      </div>

      {lines.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing posted yet. Charges and payments appear here as Stripe reports
          them.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Every charge and payment on this tenancy, oldest first, with the
              balance after each.
            </caption>
            <thead>
              <tr className="text-muted-foreground text-left text-xs">
                <th scope="col" className="py-1 pr-3 font-medium">Date</th>
                <th scope="col" className="py-1 pr-3 font-medium">What</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Amount</th>
                <th scope="col" className="py-1 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((line) => (
                <tr key={line.id} className={line.reversed ? 'text-muted-foreground' : ''}>
                  <td className="py-2 pr-3 align-top whitespace-nowrap">
                    {line.occurredAt}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    {TYPE_LABELS[line.type] ?? line.type}
                    {' — '}
                    {line.description}
                    {line.reversed && ' (later reversed)'}
                  </td>
                  <td className="py-2 pr-3 text-right align-top whitespace-nowrap">
                    {formatCents(line.amountCents)}
                  </td>
                  <td className="py-2 text-right align-top whitespace-nowrap">
                    {formatCents(line.runningBalanceCents)}
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
    </section>
  )
}
