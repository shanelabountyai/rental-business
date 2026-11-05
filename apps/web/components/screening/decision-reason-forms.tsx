'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { ReasonFormState } from '@/lib/screening/criteria-actions.ts'

// R-297 (PRD 10 §7.1): the org's decision-reason list. A reason is added
// with the criterion it rests on, or retired; it is never reworded. Both
// forms stay mounted whatever the list holds, so their notices survive.

type Action = (state: ReasonFormState, formData: FormData) => Promise<ReasonFormState>

export function AddDecisionReasonForm({
  action,
  criteria,
}: {
  action: Action
  criteria: readonly { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<ReasonFormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex max-w-prose flex-col gap-2 rounded border p-3">
      <FormAlerts state={state} />
      <TextField
        label="Reason, as it will be recorded"
        name="label"
        required
        error={state.fieldErrors?.label}
        hint="For example, Income below the written screening criteria. It cannot be reworded later; retire it and add a new one instead."
      />
      <SelectField
        label="Written criterion it rests on"
        name="criterion"
        required
        error={state.fieldErrors?.criterion}
        options={criteria}
      />
      <SubmitButton label="Add reason" />
    </form>
  )
}

/// One form with a select rather than a button per row: a row's button would
/// unmount with its own notice the moment the reason leaves the active list.
export function RetireDecisionReasonForm({
  action,
  reasons,
}: {
  action: Action
  reasons: readonly { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<ReasonFormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex max-w-prose flex-col gap-2 rounded border p-3">
      <FormAlerts state={state} />
      <SelectField label="Reason to retire" name="code" required options={reasons} />
      <SubmitButton label="Retire reason" />
    </form>
  )
}
