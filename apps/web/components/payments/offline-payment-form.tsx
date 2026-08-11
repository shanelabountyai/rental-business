'use client'

import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { OfflineFormState } from '@/lib/payments/offline.ts'

// Recording a check, a money order or cash (PAY-05, R-038).
//
// FIFTEEN SECONDS is the acceptance criterion, and it is the whole shape of
// this form. Four inputs, all above the fold, and every one of them
// pre-filled with the answer that is right most of the time: today's date, a
// check (the commonest instrument), and the full balance. A staff member with
// a check in one hand and a phone in the other should be able to submit it
// without typing anything at all in the ordinary case.
//
// The check-number field appears and disappears with the channel rather than
// sitting there greyed out - one fewer thing to read past when it does not
// apply, and it is the only field that is conditionally required.

const CHANNELS = [
  { value: 'OFFLINE_CHECK', label: 'Check' },
  { value: 'MONEY_ORDER', label: 'Money order' },
  { value: 'OFFLINE_CASH', label: 'Cash' },
] as const

export function OfflinePaymentForm({
  action,
  today,
  defaultAmountDollars,
  payerName,
}: {
  action: (state: OfflineFormState, formData: FormData) => Promise<OfflineFormState>
  today: string
  defaultAmountDollars: string
  payerName: string
}) {
  const [state, formAction] = useActionState<OfflineFormState, FormData>(action, {})
  const [channel, setChannel] = useState<string>('OFFLINE_CHECK')

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />

      <fieldset className="flex flex-wrap gap-2">
        <legend className="mb-2 text-sm font-medium">What arrived from {payerName}?</legend>
        {CHANNELS.map((option) => (
          <label
            key={option.value}
            className={`cursor-pointer rounded-md border px-3 py-2 text-sm ${
              channel === option.value ? 'border-foreground font-medium' : ''
            }`}
          >
            <input
              type="radio"
              name="channel"
              value={option.value}
              checked={channel === option.value}
              onChange={() => setChannel(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="amountDollars" className="text-sm font-medium">
            Amount
          </label>
          <div className="flex items-center gap-1">
            <span aria-hidden="true">$</span>
            <input
              id="amountDollars"
              name="amountDollars"
              type="text"
              inputMode="decimal"
              defaultValue={defaultAmountDollars}
              className="w-32 rounded-md border px-2 py-1.5"
              aria-describedby={state.fieldErrors?.amountDollars ? 'amount-error' : undefined}
            />
          </div>
          {state.fieldErrors?.amountDollars && (
            <p id="amount-error" className="text-sm text-red-700 dark:text-red-400">
              {state.fieldErrors.amountDollars}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="receivedOn" className="text-sm font-medium">
            Received on
          </label>
          {/* Native date input, not a picker component: it works on first
              paint, it is what phones already know how to render, and D-8
              says use the platform before reaching for a library. */}
          <input
            id="receivedOn"
            name="receivedOn"
            type="date"
            defaultValue={today}
            max={today}
            className="rounded-md border px-2 py-1.5"
          />
          {state.fieldErrors?.receivedOn && (
            <p className="text-sm text-red-700 dark:text-red-400">{state.fieldErrors.receivedOn}</p>
          )}
        </div>

        {channel === 'OFFLINE_CHECK' && (
          <div className="flex flex-col gap-1">
            <label htmlFor="checkNumber" className="text-sm font-medium">
              Check number
            </label>
            <input
              id="checkNumber"
              name="checkNumber"
              type="text"
              inputMode="numeric"
              className="w-28 rounded-md border px-2 py-1.5"
            />
            {state.fieldErrors?.checkNumber && (
              <p className="text-sm text-red-700 dark:text-red-400">
                {state.fieldErrors.checkNumber}
              </p>
            )}
          </div>
        )}
      </div>

      <SubmitButton label="Record this payment" />

      <p className="text-muted-foreground text-xs">
        Recorded against you as the person who took it. The billing provider is told straight away
        so the tenant is not charged again.
      </p>
    </form>
  )
}
