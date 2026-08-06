'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { WorkOrderFormState } from '@/lib/workorders/actions.ts'

/// What the job actually cost (MAINT-04). Submitting this is what triggers
/// the tolerance check - an overrun past what was approved sends the work
/// order back for re-approval, and the form says so before it is used rather
/// than surprising the PM afterwards.
export function RecordActualsForm({
  action,
  actualLaborCents,
  actualMaterialsCents,
}: {
  action: (state: WorkOrderFormState, formData: FormData) => Promise<WorkOrderFormState>
  actualLaborCents: number | null
  actualMaterialsCents: number | null
}) {
  const [state, formAction] = useActionState<WorkOrderFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-xs flex-col gap-3 border-t pt-4">
      <FormAlerts state={state} />
      <p className="text-sm font-medium">What it actually cost</p>
      <TextField
        label="Labour"
        name="actualLaborDollars"
        idPrefix="actuals"
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        defaultValue={actualLaborCents != null ? actualLaborCents / 100 : undefined}
        error={errors.actualLaborDollars}
      />
      <TextField
        label="Materials"
        name="actualMaterialsDollars"
        idPrefix="actuals"
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        defaultValue={actualMaterialsCents != null ? actualMaterialsCents / 100 : undefined}
        error={errors.actualMaterialsDollars}
        hint="Going far past the approved amount sends this back for re-approval."
      />
      <SubmitButton label="Record actuals" />
    </form>
  )
}
