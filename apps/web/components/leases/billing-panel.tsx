'use client'

import { formatCents } from '@rental/core/money'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { BillingFormState } from '@/lib/billing/actions.ts'

// A lease's billing state (D-11, R-034).
//
// A client component since R-036 gave it a re-sync button - the drift action
// the backlog asks for, on the screen where somebody notices the drift.
//
// SAYS WHICH PROVIDER IT IS, LOUDLY, when that is not real Stripe. A screen
// showing plausible `cus_`/`sub_` ids with no indication they came from a
// simulator is how somebody concludes billing is live when it is not - and
// the ids are deliberately Stripe-shaped precisely so that everything
// downstream is exercised against realistic values, which makes the label
// the only thing telling them apart.

export interface PayerBillingView {
  id: string
  name: string
  payerType: string
  portionCents: number | null
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
}

export function BillingPanel({
  leaseId,
  payers,
  live,
  providerName,
  resync,
}: {
  leaseId: string
  payers: readonly PayerBillingView[]
  live: boolean
  providerName: string
  resync: (state: BillingFormState, formData: FormData) => Promise<BillingFormState>
}) {
  const [state, action] = useActionState<BillingFormState, FormData>(resync, {})

  return (
    <section aria-labelledby="billing" className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="billing" className="text-lg font-semibold">
          Billing
        </h2>
        {!live && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            {providerName} provider — not real Stripe
          </span>
        )}
      </div>

      {payers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing yet. A Stripe customer and subscription open when the tenancy
          goes live.
        </p>
      ) : (
        <ul className="flex flex-col divide-y text-sm">
          {payers.map((payer) => (
            <li key={payer.id} className="flex flex-col gap-1 py-2">
              <span>
                {payer.name}
                <span className="text-muted-foreground">
                  {' · '}
                  {payer.payerType === 'TENANT' ? 'tenant' : payer.payerType.toLowerCase()}
                  {' · '}
                  {payer.portionCents == null
                    ? 'pays the balance'
                    : `${formatCents(payer.portionCents)} of the rent`}
                </span>
              </span>
              {payer.stripeSubscriptionId ? (
                <span className="text-muted-foreground font-mono text-xs">
                  {payer.stripeCustomerId} · {payer.stripeSubscriptionId}
                </span>
              ) : (
                <span className="text-sm text-amber-800">
                  No subscription yet — nothing will bill for this payer.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <FormAlerts state={state} />

      {payers.length > 0 && (
        <form action={action}>
          <input type="hidden" name="leaseId" value={leaseId} />
          <SubmitButton label="Re-sync with Stripe" />
        </form>
      )}

      <p className="text-muted-foreground text-xs">
        Stripe is the source of truth for invoices and payments (D-11). What
        shows on the ledger here is a projection of what Stripe reports, never
        written directly.
      </p>
    </section>
  )
}
