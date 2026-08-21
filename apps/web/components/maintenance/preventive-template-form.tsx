'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { PreventiveFormState } from '@/lib/maintenance/preventive-actions.ts'

export function PreventiveTemplateForm({
  action,
  defaults,
}: {
  action: (state: PreventiveFormState, formData: FormData) => Promise<PreventiveFormState>
  defaults: { name?: string; trade?: string; intervalMonths?: number }
}) {
  const [state, formAction] = useActionState<PreventiveFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />
      <TextField
        label="Name"
        name="name"
        required
        defaultValue={defaults.name}
        error={errors.name}
        hint="e.g. HVAC filter change, gutter cleaning, winterization - exterior faucets"
      />
      <TextField
        label="Trade (optional)"
        name="trade"
        defaultValue={defaults.trade}
        hint="Matched against a vendor's trades for auto-assignment. Leave blank if this task has no single trade."
      />
      <TextField
        label="Repeats every (months)"
        name="intervalMonths"
        type="number"
        required
        inputMode="numeric"
        min={1}
        defaultValue={defaults.intervalMonths}
        error={errors.intervalMonths}
        hint="3 for quarterly (pest), 6 for spring/fall (HVAC service), 12 for annual (chimney, water heater flush)."
      />
      <SubmitButton label="Save" />
    </form>
  )
}
