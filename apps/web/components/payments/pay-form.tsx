'use client'

import { formatCents } from '@rental/core/money'
import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton, LiveRegion } from '@/components/auth-form.tsx'
import type { PayFormState } from '@/lib/payments/actions.ts'
import type { PaymentView } from '@/lib/payments/queries.ts'

// Paying, in as few decisions as possible (PAY-01, D-10).
//
// A REAL `<form action>`, not a button with a handler. Anything that has to
// work on first paint cannot depend on hydration, and this is the screen a
// tenant opens on a phone on a bad connection on the first of the month.
// The rail choice is a radio group inside the same form, so the whole thing
// submits without JavaScript having run.
//
// The card fee is recomputed as the tenant types, which is the only reason
// this is a client component at all. PAY-01 requires the fee be disclosed
// BEFORE the choice; a figure that updates with the amount is the difference
// between a disclosure and a surprise.

const RAIL_WORDS: Record<string, { label: string; hint: string }> = {
  ACH: { label: 'Bank transfer', hint: 'Free. Takes 3–5 days to clear.' },
  CARD: { label: 'Card', hint: 'Arrives straight away.' },
  RETAIL_CASH: { label: 'Cash at a store', hint: 'Pay with cash at a shop nearby.' },
}

export function PayForm({
  view,
  action,
  cardRateBps,
  cardFixedCents,
}: {
  view: PaymentView
  action: (state: PayFormState, formData: FormData) => Promise<PayFormState>
  cardRateBps: number
  cardFixedCents: number
}) {
  const [state, formAction] = useActionState<PayFormState, FormData>(action, {})
  const [amount, setAmount] = useState((view.maxCents / 100).toFixed(2))
  const [rail, setRail] = useState('ACH')

  const amountCents = Math.round(Number(amount) * 100)
  const valid = Number.isInteger(amountCents) && amountCents > 0
  // The same gross-up `cardFeeFor` does, for display only. The action
  // recomputes it server-side and never trusts this number - see its header.
  const feeCents =
    rail === 'CARD' && valid && view.cardFeePermitted
      ? Math.ceil(((amountCents + cardFixedCents) * 10_000) / (10_000 - cardRateBps)) - amountCents
      : 0

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />

      <div className="flex flex-col gap-1">
        <label htmlFor="amountDollars" className="font-medium">
          How much are you paying?
        </label>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-lg">
            $
          </span>
          <input
            id="amountDollars"
            name="amountDollars"
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            // Large target and large text: this is a phone screen, and D-10
            // asks for a low reading level on tenant surfaces.
            className="w-40 rounded-md border px-3 py-2 text-lg"
            aria-describedby="amount-hint"
          />
        </div>
        <p id="amount-hint" className="text-muted-foreground text-sm">
          {view.allowsPartial
            ? `You owe ${formatCents(view.maxCents)}. You can pay part of it if you need to.`
            : `Your balance is ${formatCents(view.maxCents)}. This account pays the full amount.`}
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">How would you like to pay?</legend>
        {view.rails.map((option) => {
          const words = RAIL_WORDS[option.rail]!
          return (
            <label
              key={option.rail}
              className={`flex items-start gap-3 rounded-md border p-3 ${
                option.available ? 'cursor-pointer' : 'opacity-60'
              }`}
            >
              <input
                type="radio"
                name="rail"
                value={option.rail}
                checked={rail === option.rail}
                disabled={!option.available}
                onChange={() => setRail(option.rail)}
                className="mt-1"
              />
              <span className="flex flex-col">
                <span className="font-medium">{words.label}</span>
                <span className="text-muted-foreground text-sm">
                  {option.available ? words.hint : option.unavailableReason}
                </span>
              </span>
            </label>
          )
        })}
      </fieldset>

      {/* The disclosure, in money and before the choice is committed. Absent
          entirely when there is no fee, rather than rendering "$0.00" - a
          line that always shows is a line tenants learn to skip. */}
      {/* The region is always present so the fee is genuinely ANNOUNCED when
          it appears (R-101). It used to arrive already-populated, which is a
          new node rather than a change — so the one disclosure that alters
          what a tenant is about to be charged was silent. */}
      <LiveRegion>
      {feeCents > 0 && (
        <p
          className="rounded-md bg-amber-50 p-3 text-sm dark:bg-amber-950"
        >
          Paying by card adds a <strong>{formatCents(feeCents)}</strong> processing fee, so you
          will be charged <strong>{formatCents(amountCents + feeCents)}</strong> in total. Bank
          transfer is free.
        </p>
      )}
      </LiveRegion>

      <SubmitButton label={`Pay ${formatCents(valid ? amountCents + feeCents : 0)}`} />

      <p className="text-muted-foreground text-xs">
        Your card or bank details are entered on the payment provider’s own page. We never see or
        store them.
      </p>
    </form>
  )
}
