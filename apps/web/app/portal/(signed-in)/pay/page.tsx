import Link from 'next/link'
import { formatCents } from '@rental/core/money'
import { CARD_FIXED_CENTS, CARD_RATE_BPS } from '@rental/core/payments'
import { AutopayPanel } from '@/components/payments/autopay-panel.tsx'
import { PayForm } from '@/components/payments/pay-form.tsx'
import { startPayment } from '@/lib/payments/actions.ts'
import { setDebitDay, startAutopaySetup } from '@/lib/payments/autopay-actions.ts'
import { paymentView } from '@/lib/payments/queries.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'

export const metadata = { title: 'Pay rent' }

// PAY-01: "when I open the portal, then I see current balance, due date, and
// itemized charges BEFORE paying."
//
// Balance first and largest, because it is the only thing most tenants open
// this page for. The itemisation is underneath it rather than above: a
// tenant who wants to know why the number is what it is scrolls, and one who
// just wants to pay does not have to read a table first.
//
// D-10 governs every word here. "What you owe", not "outstanding balance".
// "On its way", not "pending settlement".

/// Plain words for the charge types a tenant can see. A type with no entry
/// falls back to the charge's own description rather than showing an enum.
const CHARGE_WORDS: Record<string, string> = {
  RENT: 'Rent',
  LATE_FEE: 'Late fee',
  UTILITY: 'Utilities',
  DEPOSIT: 'Deposit',
  CHARGEBACK: 'Repair you were charged for',
  NSF_FEE: 'Returned payment fee',
  OTHER: 'Other',
}

export default async function PayPage() {
  const { scope } = await requireTenantWithScope()
  const view = await paymentView(scope)

  if (!view) {
    return (
      <div className="flex max-w-xl flex-col gap-4">
        <h1 className="text-2xl font-semibold">Pay rent</h1>
        <p>
          There is no account set up to pay against yet. If you think that is wrong, please
          contact the office.
        </p>
      </div>
    )
  }

  const owesNothing = view.maxCents <= 0

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Pay rent</h1>
        <p className="text-muted-foreground">
          {view.propertyName}
          {view.unitName ? ` · ${view.unitName}` : ''}
        </p>
      </header>

      {/* ABOVE the balance and the pay form, because a tenant who sets this
          up once never has to read either again - and PAY-02 calls autopay a
          Must for exactly that reason. The publishable key is read on the
          server and passed down: it is safe to expose, but the component
          should not have to know where it lives. */}
      {/* NOT OFFERED UNDER A HOLD (PAY-12, R-047). Enrolling a held tenancy
          in autopay is the exact defect this control exists to prevent: a
          charge that fires the morning after a notice is served. The hold
          pauses the subscription, so an enrolment here would either fail
          confusingly or start collecting the moment the hold lifted —
          neither is something to offer somebody mid-case. */}
      {!view.hold.blockOnline && !view.hold.certifiedFundsOnly && (
      <AutopayPanel
        publishableKey={process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null}
        alreadyOn={view.autopayOn}
        debitDay={view.debitDay}
        rentDueDay={view.rentDueDay}
        latestSafeDebitDay={view.latestSafeDebitDay}
        start={startAutopaySetup}
        saveDebitDay={setDebitDay}
      />
      )}

      {/* The way to "did you get my payment?" (R-043). Above the pay form so
          a tenant checking rather than paying does not have to scroll past a
          payment button to find it, and a link rather than an inline list so
          paying stays three taps. */}
      <Link
        href="/portal/pay/history"
        className="focus-visible:ring-ring w-fit text-sm underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
      >
        See everything you have paid
      </Link>

      <section aria-labelledby="balance" className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 id="balance" className="text-muted-foreground text-sm font-medium">
          What you owe
        </h2>
        <p className="text-4xl font-semibold">{formatCents(Math.max(0, view.balanceCents))}</p>
        {view.inFlightCents > 0 && (
          <p className="text-sm">
            {formatCents(view.inFlightCents)} of this is already on its way and can take a few
            days to clear. You do not need to pay it again.
          </p>
        )}
        {view.balanceCents < 0 && (
          <p className="text-sm">
            You are {formatCents(-view.balanceCents)} ahead. Nothing is due right now.
          </p>
        )}
      </section>

      {view.charges.length > 0 && (
        <section aria-labelledby="charges" className="flex flex-col gap-2">
          <h2 id="charges" className="text-lg font-semibold">
            What it is made up of
          </h2>
          <ul className="flex flex-col divide-y text-sm">
            {view.charges.map((charge) => (
              <li key={charge.id} className="flex items-baseline justify-between gap-4 py-2">
                <span className="flex flex-col">
                  <span>{CHARGE_WORDS[charge.type] ?? charge.description}</span>
                  {charge.dueOn && (
                    <span className="text-muted-foreground text-xs">
                      Due {charge.dueOn.toISOString().slice(0, 10)}
                    </span>
                  )}
                </span>
                <span className="font-medium">{formatCents(charge.outstandingCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.hold.blockOnline || view.hold.certifiedFundsOnly ? (
        // PAY-12 (R-047). Neutral, and it never says why: a payment screen
        // is not lawful service of a notice, and the device may be handed
        // around a household that is not party to the case.
        <p className="rounded-md border p-4">
          {view.hold.certifiedFundsOnly
            ? 'This account can only be paid by cashier’s cheque or money order. Please contact the office to arrange it.'
            : 'Online payments are not available on this account. Please contact the office.'}
        </p>
      ) : owesNothing ? (
        <p className="rounded-md border p-4">
          {view.inFlightCents > 0
            ? 'Everything you owe is already on its way. We will email you when it clears.'
            : 'Your balance is clear — there is nothing to pay right now.'}
        </p>
      ) : !view.hasPaymentMethod ? (
        <p className="rounded-md border p-4">
          Your payment account is still being set up. Please contact the office and we will sort
          it out.
        </p>
      ) : (
        <PayForm
          view={view}
          // Bound server-side. A plain function cannot cross this boundary -
          // only a `'use server'` export has an identity the client can call
          // back to, and `npm run build` does not catch the difference.
          action={startPayment}
          cardRateBps={CARD_RATE_BPS}
          cardFixedCents={CARD_FIXED_CENTS}
        />
      )}
    </div>
  )
}
