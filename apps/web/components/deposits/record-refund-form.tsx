'use client'

import { DEPOSIT_REFUND_INSTRUMENTS } from '@rental/core/ledger'
import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { DepositFormState } from '@/lib/deposits/actions.ts'

// The disbursement itself (R-170). The letter promised the money; nothing
// until this point moved it, and the deposit stays on the books as a
// liability until this form is filled in.
//
// LABELS ARE SCOPED TO THE REFUND, not to "Amount"/"Reference"/"Date", because
// this panel shares `/leases/[id]/deposit` with the deductions list and the
// totals - the collision trap CLAUDE.md records four instances of. Nothing
// else on this page says "refund".

export function RecordRefundForm({
  action,
  amountLabel,
  today,
}: {
  action: (state: DepositFormState, formData: FormData) => Promise<DepositFormState>
  amountLabel: string
  today: string
}) {
  const [state, formAction] = useActionState<DepositFormState, FormData>(action, {})
  const [method, setMethod] = useState('OFFLINE_CHECK')
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} encType="multipart/form-data" className="flex flex-col gap-4">
      <FormAlerts state={state} />
      <p className="text-sm">
        Amount refunded: <span className="font-medium tabular-nums">{amountLabel}</span>
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="How the refund was paid"
          name="method"
          idPrefix="refund"
          required
          defaultValue={method}
          placeholder="Choose"
          options={Object.entries(DEPOSIT_REFUND_INSTRUMENTS).map(([value, label]) => ({
            value,
            label,
          }))}
          error={errors.method}
          onChange={(event) => setMethod(event.target.value)}
        />
        {/* Native date input: it works on first paint and phones already know
            how to render it (D-8), the same call `offline-payment-form.tsx`
            makes for the day money arrives. `max` is today on the property's
            clock - the action refuses a future date either way. */}
        <TextField
          label="Date the refund was paid"
          name="paidOn"
          type="date"
          defaultValue={today}
          max={today}
          required
          error={errors.paidOn}
        />
      </div>
      {method !== 'OFFLINE_CASH' && (
        <TextField
          label="Check, trace or confirmation number"
          name="reference"
          error={errors.reference}
          hint="How this payment is matched back to a bank statement months later."
        />
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="refund-file" className="text-sm font-medium">
          Check image or remittance advice (optional)
        </label>
        <input id="refund-file" type="file" name="file" className="text-sm" />
      </div>
      <SubmitButton label="Record refund payment" />
    </form>
  )
}
