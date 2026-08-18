'use client'

import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField, TextareaField } from '@/components/form/field.tsx'
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

export function PrescreenForm({
  action,
}: {
  action: (state: PrescreenFormState, formData: FormData) => Promise<PrescreenFormState>
}) {
  const [state, formAction] = useActionState<PrescreenFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const [priorEvictions, setPriorEvictions] = useState<string | null>(null)

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />

      <TextField
        label="When would you move in?"
        name="moveDate"
        type="date"
        required
        idPrefix="prescreen"
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
        error={errors.occupants}
      />
      <TextareaField
        label="Any pets?"
        name="petsDescription"
        idPrefix="prescreen"
        error={errors.petsDescription}
        hint="Species, breed, size - or leave blank for none."
        rows={2}
      />
      <SelectField
        label="Household income range"
        name="incomeRange"
        idPrefix="prescreen"
        required
        error={errors.incomeRange}
        options={INCOME_RANGE_OPTIONS}
      />

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
              onChange={() => setPriorEvictions('yes')}
              className="size-5"
            />
            Yes
          </label>
        </div>
        {errors.priorEvictions && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {errors.priorEvictions}
          </p>
        )}
        {priorEvictions === 'yes' && (
          <TextareaField
            label="Briefly, what happened?"
            name="priorEvictionsDetail"
            idPrefix="prescreen"
            error={errors.priorEvictionsDetail}
            hint="This does not disqualify you on its own."
            rows={3}
          />
        )}
      </fieldset>

      <SubmitButton label="Submit" />
    </form>
  )
}
