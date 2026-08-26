import { formatCents } from '@rental/core/money'
import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { tenantStatement } from '@/lib/payments/queries.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'

export const metadata = { title: 'Your payments' }

// The tenant's own ledger (PAY-03, R-043).
//
// ==========================================================================
// THE PAY SCREEN ANSWERS "WHAT DO I OWE". THIS ANSWERS "DID YOU GET IT".
//
// Those are different questions and only one of them was answerable from the
// portal. The backlog's claim for this item is that half of the "you didn't
// credit my payment" calls disappear once a tenant can see their own history,
// and this is the screen that has to earn it.
//
// ITS OWN PAGE, not another section on /portal/pay. PAY-01 wants paying to be
// three taps, and a history list above or below the pay button is exactly the
// thing that pushes the button off a phone screen. A tenant who wants to pay
// and a tenant who wants to check are in different moods and want different
// pages.
// ==========================================================================
//
// D-10 GOVERNS EVERY WORD. "What you paid", not "credits"; "What you were
// charged", not "debits"; no "running balance" column header, because a
// tenant reading a statement is not an accountant and the word costs nothing
// to avoid. The NUMBERS are identical to the staff view by construction —
// `tenantStatement` calls the same `statement()` and `balanceCents()` that
// `leaseStatement()` does — because a tenant and a PM seeing different
// balances is the argument this feature exists to prevent.

export default async function PaymentHistoryPage() {
  const { scope } = await requireTenantWithScope()
  const view = await tenantStatement(scope)

  if (!view) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold">Your payments</h1>
        <p>There is nothing on your account yet.</p>
      </div>
    )
  }

  const owes = view.balanceCents > 0

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/portal/pay"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Pay rent
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Your payments</h1>
        <p className="text-muted-foreground text-sm">
          {view.propertyName} — {view.unitName}
        </p>
      </header>

      <section aria-labelledby="now" className="flex flex-col gap-1 rounded-lg border p-4">
        <h2 id="now" className="text-muted-foreground text-sm font-medium">
          {owes ? 'What you owe right now' : 'Your balance'}
        </h2>
        <p className="text-3xl font-semibold">
          {formatCents(Math.abs(view.balanceCents))}
        </p>
        {!owes && (
          <p className="text-muted-foreground text-sm">
            {view.balanceCents === 0
              ? 'Nothing is due.'
              : 'You are ahead — this is credit on your account.'}
          </p>
        )}
      </section>

      <section aria-labelledby="history" className="flex flex-col gap-3">
        <h2 id="history" className="text-lg font-semibold">
          Everything on your account
        </h2>

        {view.lines.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing has been charged yet.</p>
        ) : (
          // Newest first for READING, though the running balance was computed
          // oldest-first in core — the number beside a line is the balance
          // after that line, whichever order it is displayed in. A tenant
          // opens this to check the most recent thing, not to read a year
          // from the beginning.
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Every charge and payment on your account, newest first, with
                what you owed after each one.
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
                        {/* The PROPERTY's clock, not the server's (R-101c). */}
                        {friendlyDate(line.occurredAt, view.timezone)}
                      </td>
                      <td className="py-2 pr-3">
                        {/* Its own element, so the description is addressable
                            on its own — the reversal note below shares this
                            cell, and running them together makes one string
                            out of two separate facts. */}
                        <span>{line.description}</span>
                        {wasReversed && (
                          // Said plainly rather than hidden. D-11 keeps the
                          // original row visible and adds a reversal beside
                          // it; a tenant who sees a payment listed and then
                          // reversed needs to know which it was, or the
                          // statement looks like it double-counted.
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
                        {/* A payment reduces what is owed, so it shows as a
                            minus. The sign is not decoration: it is how a
                            tenant tells "you charged me" from "I paid you"
                            at a glance. */}
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

      <p className="text-muted-foreground text-xs">
        If something here does not look right, message us from your portal — it
        is easier to sort out with the dates in front of us.
      </p>
    </div>
  )
}
