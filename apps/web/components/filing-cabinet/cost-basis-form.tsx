'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/filing-cabinet/actions.ts'

export function CostBasisForm({
  action,
  costBasisCents,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  costBasisCents: number | null
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-4 sm:max-w-xs">
      <FormAlerts state={state} />
      <TextField
        label="Cost basis ($)"
        name="costBasisDollars"
        idPrefix="costbasis"
        type="number"
        min={0}
        step="0.01"
        required={false}
        defaultValue={costBasisCents != null ? costBasisCents / 100 : undefined}
        error={errors.costBasisDollars}
        hint="From the deed or closing disclosure."
      />
      <SubmitButton label="Save" />
    </form>
  )
}
