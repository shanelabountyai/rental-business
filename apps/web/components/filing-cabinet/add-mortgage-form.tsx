'use client'

import { MORTGAGE_RATE_TYPES } from '@rental/core/filing-cabinet'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField, SelectField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/filing-cabinet/actions.ts'

const RATE_TYPE_LABELS: Record<string, string> = { FIXED: 'Fixed', ARM: 'ARM' }

export function AddMortgageForm({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-4 sm:max-w-md">
      <FormAlerts state={state} />
      <TextField label="Lender" name="lender" idPrefix="mortgage" required error={errors.lender} />
      <SelectField
        label="Rate type"
        name="rateType"
        idPrefix="mortgage"
        required
        error={errors.rateType}
        options={MORTGAGE_RATE_TYPES.map((t) => ({ value: t, label: RATE_TYPE_LABELS[t] ?? t }))}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Original amount ($)"
          name="originalAmountDollars"
          idPrefix="mortgage"
          type="number"
          min={0}
          step="0.01"
          required={false}
          error={errors.originalAmountCents}
        />
        <TextField
          label="Current balance ($)"
          name="currentBalanceDollars"
          idPrefix="mortgage"
          type="number"
          min={0}
          step="0.01"
          required={false}
          error={errors.currentBalanceCents}
        />
      </div>
      <TextField
        label="Interest rate (%)"
        name="interestRatePercent"
        idPrefix="mortgage"
        type="number"
        min={0}
        step="0.01"
        required={false}
        error={errors.interestRateBps}
      />
      <TextField
        label="Next ARM adjustment date"
        name="armAdjustmentDate"
        idPrefix="mortgage"
        type="date"
        required={false}
        error={errors.armAdjustmentDate}
        hint="Required for an ARM. Alerted 60 days out."
      />
      <TextField
        label="Maturity date"
        name="maturityDate"
        idPrefix="mortgage"
        type="date"
        required={false}
        error={errors.maturityDate}
      />
      <CheckboxField
        label="Balloon payment"
        name="isBalloon"
        hint="Alerted 180 days before the maturity date above."
      />
      <TextField label="Notes" name="notes" idPrefix="mortgage" required={false} error={errors.notes} />
      <SubmitButton label="Add mortgage" />
    </form>
  )
}
