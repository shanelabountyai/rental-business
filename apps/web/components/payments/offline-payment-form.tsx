'use client'

import { useActionState, useState } from 'react'
import { FieldError, TextField } from '@/components/form/field.tsx'
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
          // H5 (R-099): the input is `sr-only`, so it never draws a focus
          // ring of its own and the ring has to live on the label that
          // visually replaces it. Without `focus-within` a keyboard user
          // tabbing into this group gets NO visible indication of where they
          // are - the control looks identical focused and unfocused. Mine,
          // from R-038.
          <label
            key={option.value}
            className={`focus-within:ring-ring cursor-pointer rounded-md border px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-offset-2 ${
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
          <FieldError id="amount-error" message={state.fieldErrors?.amountDollars} />
        </div>

        {/* M8 (R-099): both of these rendered their error as a bare <p> with
            no id, no `aria-describedby` and no `role="alert"` - so a screen
            reader never associated the message with the field and never
            announced it arriving. `TextField` had solved exactly this since
            R-008 and I did not use it. Native date input either way: it works
            on first paint, phones already know how to render it, and D-8 says
            use the platform before reaching for a library. */}
        <TextField
          label="Received on"
          name="receivedOn"
          type="date"
          defaultValue={today}
          max={today}
          error={state.fieldErrors?.receivedOn}
        />

        {channel === 'OFFLINE_CHECK' && (
          <TextField
            label="Check number"
            name="checkNumber"
            inputMode="numeric"
            error={state.fieldErrors?.checkNumber}
          />
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
