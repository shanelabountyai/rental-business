'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/filing-cabinet/actions.ts'

export function AddInsurancePolicyForm({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-4 sm:max-w-md">
      <FormAlerts state={state} />
      <TextField label="Carrier" name="carrier" idPrefix="insurance" required error={errors.carrier} />
      <TextField
        label="Policy number"
        name="policyNumber"
        idPrefix="insurance"
        required={false}
        error={errors.policyNumber}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Coverage limits ($)"
          name="limitsDollars"
          idPrefix="insurance"
          type="number"
          min={0}
          step="0.01"
          required={false}
          error={errors.limitsCents}
        />
        <TextField
          label="Deductible ($)"
          name="deductibleDollars"
          idPrefix="insurance"
          type="number"
          min={0}
          step="0.01"
          required={false}
          error={errors.deductibleCents}
        />
      </div>
      <TextField
        label="Renews on"
        name="renewsOn"
        idPrefix="insurance"
        type="date"
        required
        error={errors.renewsOn}
        hint="Alerted 60 days before renewal - the shopping window."
      />
      <CheckboxField label="Loss-of-rents coverage" name="lossOfRents" />
      <TextField label="Notes" name="notes" idPrefix="insurance" required={false} error={errors.notes} />
      <SubmitButton label="Add policy" />
    </form>
  )
}
