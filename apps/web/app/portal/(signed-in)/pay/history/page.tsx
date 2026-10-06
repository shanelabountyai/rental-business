import { formatCents } from '@rental/core/money'
import Link from 'next/link'
import { PageHeader } from '@/components/page-header.tsx'
import { tenantStatement } from '@/lib/payments/queries.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { StatementTable } from '@/components/portal/statement-table.tsx'

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
        <PageHeader title="Your payments" />
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
          <StatementTable
            lines={view.lines}
            reversed={view.reversed}
            timezone={view.timezone}
            label="Your payments, scrolls sideways"
            caption="Every charge and payment on your account, newest first, with what you owed after each one."
          />
        )}
      </section>

      <p className="text-muted-foreground text-xs">
        If something here does not look right, message us from your portal — it
        is easier to sort out with the dates in front of us.
      </p>
    </div>
  )
}
