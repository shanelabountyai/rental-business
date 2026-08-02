'use client'

import { US_STATE_OPTIONS } from '@rental/core/property'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/properties/actions.ts'

const ENTITY_TYPE_OPTIONS = [
  { value: 'LLC', label: 'LLC' },
  { value: 'PERSONAL', label: 'Personal' },
  { value: 'TRUST', label: 'Trust' },
  { value: 'CORPORATION', label: 'Corporation' },
  { value: 'PARTNERSHIP', label: 'Partnership' },
]

export function EntityForm({
  action,
  submitLabel,
  defaults,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  submitLabel: string
  defaults?: { name?: string; type?: string; formationState?: string }
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-5">
      <FormAlerts state={state} />
      <TextField
        label="Name"
        name="name"
        required
        defaultValue={defaults?.name}
        error={errors.name}
      />
      <SelectField
        label="Type"
        name="type"
        required
        defaultValue={defaults?.type}
        error={errors.type}
        options={ENTITY_TYPE_OPTIONS}
      />
      <SelectField
        label="Formation state (optional)"
        name="formationState"
        defaultValue={defaults?.formationState}
        error={errors.formationState}
        placeholder="Not specified"
        options={US_STATE_OPTIONS.map((s) => ({
          value: s.code,
          label: `${s.code} — ${s.name}`,
        }))}
      />
      <SubmitButton label={submitLabel} />
    </form>
  )
}
