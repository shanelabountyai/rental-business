import { formatCents } from '@rental/core/money'
import { CARD_FIXED_CENTS, CARD_RATE_BPS } from '@rental/core/payments'
import { AutopayPanel } from '@/components/payments/autopay-panel.tsx'
import { PayForm } from '@/components/payments/pay-form.tsx'
import { startPayment } from '@/lib/payments/actions.ts'
import { startAutopaySetup } from '@/lib/payments/autopay-actions.ts'
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
      <AutopayPanel
        publishableKey={process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null}
        alreadyOn={view.autopayOn}
        start={startAutopaySetup}
      />

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

      {owesNothing ? (
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
