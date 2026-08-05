'use client'

import { SHUTOFF_TYPES } from '@rental/core/operational'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/operational/actions.ts'

const TYPE_LABELS: Record<string, string> = {
  WATER_MAIN: 'Water main',
  BREAKER_PANEL: 'Breaker panel',
  GAS: 'Gas',
  OTHER: 'Other',
}

/// Sets (or replaces) the description for one shutoff type - ShutoffLocation
/// is unique per (unit, type), so this is always "the current word on where
/// the water main is," never a growing list. Attach a photo separately via
/// Documents below (type "Shutoff photo") - the same unit-scoped upload
/// R-012 already built, not duplicated here.
export function ShutoffLocationForm({
  action,
  defaultType,
  defaultDescription,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  defaultType?: string
  defaultDescription?: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <FormAlerts state={state} />
      <div className="min-w-40">
        <SelectField
          label="Type"
          name="type"
          idPrefix="shutoff"
          required
          defaultValue={defaultType}
          error={errors.type}
          options={SHUTOFF_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t }))}
        />
      </div>
      <TextField
        label="Where is it?"
        name="description"
        idPrefix="shutoff"
        required
        defaultValue={defaultDescription}
        error={errors.description}
        hint="Enough detail for someone in a hurry."
      />
      <SubmitButton label="Save" />
    </form>
  )
}
