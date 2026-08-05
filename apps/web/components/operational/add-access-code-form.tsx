'use client'

import { ACCESS_CODE_TYPES } from '@rental/core/operational'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/operational/actions.ts'

const TYPE_LABELS: Record<string, string> = {
  LOCKBOX: 'Lockbox',
  SMART_LOCK: 'Smart lock',
  GATE: 'Gate',
  MAILBOX: 'Mailbox',
  OTHER: 'Other',
}

export function AddAccessCodeForm({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <FormAlerts state={state} />
      <div className="min-w-36">
        <SelectField
          label="Type"
          name="type"
          idPrefix="code"
          required
          error={errors.type}
          options={ACCESS_CODE_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t }))}
        />
      </div>
      <TextField
        label="Label (optional)"
        name="label"
        idPrefix="code"
        required={false}
        error={errors.label}
        hint='"Front door"'
      />
      <TextField label="Code" name="code" idPrefix="code" required error={errors.code} />
      <SubmitButton label="Save code" />
    </form>
  )
}
