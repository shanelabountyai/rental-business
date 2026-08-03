'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/units/actions.ts'

const STATUS_OPTIONS = [
  { value: 'OCCUPIED', label: 'Occupied' },
  { value: 'VACANT', label: 'Vacant' },
  { value: 'MAKE_READY', label: 'Make-ready' },
  { value: 'DOWN', label: 'Down' },
]

export interface UnitDefaults {
  name?: string
  status?: string
  marketDollars?: number | ''
  bedrooms?: number | ''
  bathrooms?: number | ''
  squareFeet?: number | ''
  notes?: string
}

/// Create and edit share this form. No status-transition restrictions (see
/// packages/core/units/validate.ts) - status is a plain select staff can set
/// to anything, since the one automated rule (lease ends without a renewal ->
/// make-ready) is not something a form needs to enforce against a human.
export function UnitForm({
  action,
  submitLabel,
  defaults,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  submitLabel: string
  defaults: UnitDefaults
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-5">
      <FormAlerts state={state} />

      <TextField
        label="Unit name"
        name="name"
        required
        defaultValue={defaults.name}
        error={errors.name}
        hint='"Main house", "ADU", "Unit A" - unique within the property.'
      />

      <SelectField
        label="Status"
        name="status"
        required
        defaultValue={defaults.status}
        error={errors.status}
        options={STATUS_OPTIONS}
      />

      <TextField
        label="Market rent (monthly, $)"
        name="marketDollars"
        type="number"
        inputMode="decimal"
        min={0}
        step={1}
        defaultValue={defaults.marketDollars}
        error={errors.marketRentCents}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <TextField
          label="Bedrooms"
          name="bedrooms"
          type="number"
          inputMode="numeric"
          min={0}
          max={20}
          defaultValue={defaults.bedrooms}
          error={errors.bedrooms}
        />
        <TextField
          label="Bathrooms"
          name="bathrooms"
          type="number"
          inputMode="decimal"
          min={0}
          max={20}
          step={0.5}
          defaultValue={defaults.bathrooms}
          error={errors.bathrooms}
        />
        <TextField
          label="Square feet"
          name="squareFeet"
          type="number"
          inputMode="numeric"
          min={0}
          defaultValue={defaults.squareFeet}
          error={errors.squareFeet}
        />
      </div>

      <TextField
        label="Notes"
        name="notes"
        defaultValue={defaults.notes}
        error={errors.notes}
      />

      <SubmitButton label={submitLabel} />
    </form>
  )
}
