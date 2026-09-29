'use client'

import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton, useFormVersion } from '@/components/auth-form.tsx'
import { FieldError, SelectField, TextField, TextareaField } from '@/components/form/field.tsx'
import type { PrescreenFormState } from '@/lib/prospects/prescreen-actions.ts'

// The five fixed pre-screening questions (LEASE-07, R-058) - identical for
// every prospect, which is exactly why this form has no per-property
// configuration anywhere in it.

const INCOME_RANGE_OPTIONS = [
  { value: 'UNDER_3000', label: 'Under $3,000/mo' },
  { value: 'RANGE_3000_5000', label: '$3,000–$5,000/mo' },
  { value: 'RANGE_5000_8000', label: '$5,000–$8,000/mo' },
  { value: 'OVER_8000', label: 'Over $8,000/mo' },
]

// Its own component, mounted INSIDE the keyed `<form>` below - the
// `priorEvictions` toggle is local UI state with no `name` of its own, so
// remounting the form (R-114's fix for the fields around it) is also what
// re-seeds this from whatever was echoed back after a refusal.
function PriorEvictionsFieldset({
  echoedValue,
  radioError,
  detailError,
}: {
  echoedValue: string | undefined
  radioError: string | undefined
  detailError: string | undefined
}) {
  const [priorEvictions, setPriorEvictions] = useState<string | null>(echoedValue || null)

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">
        Have you been evicted before?
        <span aria-hidden="true"> *</span>
      </legend>
      <div className="flex gap-4">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="radio"
            name="priorEvictions"
            value="no"
            required
            defaultChecked={echoedValue === 'no'}
            onChange={() => setPriorEvictions('no')}
            className="size-5"
          />
          No
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="radio"
            name="priorEvictions"
            value="yes"
            required
            defaultChecked={echoedValue === 'yes'}
            onChange={() => setPriorEvictions('yes')}
            className="size-5"
          />
          Yes
        </label>
      </div>
      <FieldError id="field-prior-evictions-error" message={radioError} />
      {priorEvictions === 'yes' && (
        <TextareaField
          label="Briefly, what happened?"
          name="priorEvictionsDetail"
          idPrefix="prescreen"
          error={detailError}
          hint="This does not disqualify you on its own."
          rows={3}
        />
      )}
    </fieldset>
  )
}

export function PrescreenForm({
  action,
}: {
  action: (state: PrescreenFormState, formData: FormData) => Promise<PrescreenFormState>
}) {
  const [state, formAction] = useActionState<PrescreenFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  // What was typed, handed back after a refusal, and the `key` that makes it
  // survive React 19's post-dispatch reset (R-114, `useFormVersion`).
  const echoed = state.values ?? {}
  const formVersion = useFormVersion(state)

  return (
    <div className="flex flex-col gap-5">
      <FormAlerts state={state} />

      <form key={formVersion} action={formAction} className="flex flex-col gap-5">
        <TextField
          label="When would you move in?"
          name="moveDate"
          type="date"
          required
          idPrefix="prescreen"
          defaultValue={echoed.moveDate}
          error={errors.moveDate}
        />
        <TextField
          label="How many people would live there?"
          name="occupants"
          type="number"
          min="1"
          max="20"
          inputMode="numeric"
          required
          idPrefix="prescreen"
          defaultValue={echoed.occupants}
          error={errors.occupants}
        />
        <TextareaField
          label="Any pets?"
          name="petsDescription"
          idPrefix="prescreen"
          defaultValue={echoed.petsDescription}
          error={errors.petsDescription}
          hint="Species, breed, size - or leave blank for none."
          rows={2}
        />
        <SelectField
          label="Household income range"
          name="incomeRange"
          idPrefix="prescreen"
          required
          defaultValue={echoed.incomeRange}
          error={errors.incomeRange}
          options={INCOME_RANGE_OPTIONS}
        />

        <PriorEvictionsFieldset
          echoedValue={echoed.priorEvictions}
          radioError={errors.priorEvictions}
          detailError={errors.priorEvictionsDetail}
        />

        <SubmitButton label="Submit" />
      </form>
    </div>
  )
}
