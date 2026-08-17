'use client'

import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField, TextField, TextareaField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/listings/actions.ts'

// The listing form (LEASE-01, R-056), shared by create and edit.

export interface ListingDefaults {
  headline?: string
  description?: string
  rentDollars?: number | ''
  depositDollars?: number | ''
  availableOn?: string
  requirements?: string
  petsAllowed?: boolean
  petPolicyText?: string
}

export function ListingForm({
  action,
  submitLabel,
  defaults,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  submitLabel: string
  defaults: ListingDefaults
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const [petsAllowed, setPetsAllowed] = useState(defaults.petsAllowed ?? false)

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-5">
      <FormAlerts state={state} />

      <TextField
        label="Headline (optional)"
        name="headline"
        idPrefix="listing"
        defaultValue={defaults.headline}
        error={errors.headline}
        hint="Shown at the top of the public page. Leave blank to use the address."
      />

      <TextareaField
        label="Description"
        name="description"
        idPrefix="listing"
        defaultValue={defaults.description}
        error={errors.description}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Asking rent (dollars)"
          name="rentDollars"
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          required
          idPrefix="listing"
          defaultValue={defaults.rentDollars}
          error={errors.rentCents}
        />
        <TextField
          label="Asking deposit (dollars)"
          name="depositDollars"
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          idPrefix="listing"
          defaultValue={defaults.depositDollars}
          error={errors.depositCents}
          hint="Leave blank to state no deposit amount."
        />
      </div>

      <TextField
        label="Available on"
        name="availableOn"
        type="date"
        required
        idPrefix="listing"
        defaultValue={defaults.availableOn}
        error={errors.availableOn}
      />

      <TextareaField
        label="Requirements"
        name="requirements"
        idPrefix="listing"
        defaultValue={defaults.requirements}
        error={errors.requirements}
        hint="Income, credit, screening criteria - whatever an applicant should know before applying."
      />

      <div className="flex flex-col gap-3 rounded-md border p-4">
        <CheckboxField
          label="Pets allowed"
          name="petsAllowed"
          defaultChecked={defaults.petsAllowed}
          onChange={setPetsAllowed}
        />
        {petsAllowed && (
          <TextareaField
            label="Pet policy"
            name="petPolicyText"
            idPrefix="listing"
            required
            defaultValue={defaults.petPolicyText}
            error={errors.petPolicyText}
            hint="Species, breed or size limits, fee, deposit."
            rows={3}
          />
        )}
      </div>

      <SubmitButton label={submitLabel} />
    </form>
  )
}
