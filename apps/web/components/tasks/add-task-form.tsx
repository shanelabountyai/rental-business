'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/tasks/actions.ts'

const PRIORITY_OPTIONS = [
  { value: 'ROUTINE', label: 'Routine' },
  { value: 'URGENT', label: 'Urgent' },
  { value: 'EMERGENCY', label: 'Emergency' },
]

/// The one staff-initiated way a task gets created today - everything else
/// is a future producer calling createTask() from a domain event.
export function AddTaskForm({
  action,
  submitLabel,
  properties,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  submitLabel: string
  properties: readonly { id: string; name: string }[]
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-5">
      <FormAlerts state={state} />
      <SelectField
        label="Property"
        name="propertyId"
        required
        defaultValue={properties.length === 1 ? properties[0]!.id : undefined}
        error={errors.propertyId}
        options={properties.map((p) => ({ value: p.id, label: p.name }))}
      />
      <TextField
        label="Title"
        name="title"
        required
        error={errors.title}
        hint='"Check smoke detector batteries", "Call insurance re: renewal".'
      />
      <SelectField
        label="Priority"
        name="priority"
        required
        defaultValue="ROUTINE"
        error={errors.priority}
        options={PRIORITY_OPTIONS}
      />
      <SubmitButton label={submitLabel} />
    </form>
  )
}
