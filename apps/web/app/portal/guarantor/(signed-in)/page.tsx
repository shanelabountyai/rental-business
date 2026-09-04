import { formatCents } from '@rental/core/money'
import { friendlyDate } from '@rental/core/scheduling'
import { guarantorStatement } from '@/lib/payments/queries.ts'
import { requireGuarantorWithScope } from '@/lib/portal/guarantor-guard.ts'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

export const metadata = { title: 'What you guarantee' }

// LEASE-06/R-165: what a guarantor is entitled to - the balance and the
// full ledger behind it, and nothing else. No pay button (a guarantor is
// not the payer - see guarantorStatement's own comment), no maintenance, no
// messages.
//
// THE NUMBERS ARE THE SAME NUMBERS a tenant and a staff member would see for
// this lease, by construction - guarantorStatement calls the identical
// statement()/balanceCents(). A guarantor reading a different balance than
// everybody else on the tenancy is the dispute this screen exists to avoid.

export default async function GuarantorBalancePage() {
  const { leaseId } = await requireGuarantorWithScope()
  const view = await guarantorStatement(leaseId)

  if (!view) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">What you guarantee</h1>
        <p>There is nothing on this lease&apos;s account yet.</p>
      </div>
    )
  }

  const owed = view.balanceCents > 0

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">What you guarantee</h1>
        <p className="text-muted-foreground text-sm">
          {view.propertyName} — {view.unitName}
        </p>
      </header>

      <section aria-labelledby="now" className="flex flex-col gap-1 rounded-lg border p-4">
        <h2 id="now" className="text-muted-foreground text-sm font-medium">
          {owed ? 'What is currently owed' : 'Current balance'}
        </h2>
        <p className="text-3xl font-semibold">{formatCents(Math.abs(view.balanceCents))}</p>
        {!owed && (
          <p className="text-muted-foreground text-sm">
            {view.balanceCents === 0 ? 'Nothing is due.' : 'The account is ahead — this is credit on it.'}
          </p>
        )}
      </section>

      <section aria-labelledby="history" className="flex flex-col gap-3">
        <h2 id="history" className="text-lg font-semibold">
          Everything on this account
        </h2>

        {view.lines.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing has been charged yet.</p>
        ) : (
          <div className="overflow-x-auto" {...scrollableRegionProps('The account ledger, scrolls sideways')}>
            <table className="w-full text-sm">
              <caption className="sr-only">
                Every charge and payment on this account, newest first, with what
                was owed after each one.
              </caption>
              <thead>
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
              <tbody>
                {[...view.lines].reverse().map((line) => {
                  const isPayment = line.amountCents < 0
                  const wasReversed = view.reversed.has(line.id)
                  return (
                    <tr key={line.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {friendlyDate(line.occurredAt, view.timezone)}
                      </td>
                      <td className="py-2 pr-3">
                        <span>{line.description}</span>
                        {wasReversed && (
                          <span className="text-muted-foreground block text-xs">
                            This was later reversed
                          </span>
                        )}
                      </td>
                      <td
                        className={`py-2 pr-3 text-right whitespace-nowrap tabular-nums ${
                          isPayment ? 'text-emerald-700' : ''
                        }`}
                      >
                        {isPayment ? '−' : ''}
                        {formatCents(Math.abs(line.amountCents))}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap tabular-nums">
                        {formatCents(Math.max(0, line.runningBalanceCents))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
