'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField, TextareaField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/screening/criteria-actions.ts'

export interface CriteriaFormDefaults {
  effectiveFrom?: string
  incomeToRentMultiplier?: number | ''
  minCreditScore?: number | ''
  evictionLookbackMonths?: number | ''
  criminalLookbackMonths?: number | ''
  citation?: string
  notes?: string
}

export function CriteriaForm({
  action,
  submitLabel,
  defaults,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  submitLabel: string
  defaults: CriteriaFormDefaults
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-8">
      <FormAlerts state={state} />

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">Criteria</legend>
        <TextField
          label="Effective from"
          name="effectiveFrom"
          type="date"
          required
          defaultValue={defaults.effectiveFrom}
          error={errors.effectiveFrom}
          hint="Prospective only - this cannot predate the version it replaces."
        />
        <TextField
          label="Income-to-rent multiplier (x)"
          name="incomeToRentMultiplier"
          type="number"
          inputMode="decimal"
          min={0}
          step={0.1}
          required
          defaultValue={defaults.incomeToRentMultiplier}
          error={errors.incomeToRentMultiplierX100}
          hint="Minimum monthly income as a multiple of rent, e.g. 3 for 3x rent."
        />
        <TextField
          label="Credit floor (optional)"
          name="minCreditScore"
          type="number"
          inputMode="numeric"
          min={300}
          max={850}
          defaultValue={defaults.minCreditScore}
          error={errors.minCreditScore}
          hint="Compared against the provider's reported score. Blank means no floor."
        />
        <TextField
          label="Eviction lookback (months)"
          name="evictionLookbackMonths"
          type="number"
          inputMode="numeric"
          min={0}
          required
          defaultValue={defaults.evictionLookbackMonths}
          error={errors.evictionLookbackMonths}
        />
        <TextField
          label="Criminal lookback (months)"
          name="criminalLookbackMonths"
          type="number"
          inputMode="numeric"
          min={0}
          required
          defaultValue={defaults.criminalLookbackMonths}
          error={errors.criminalLookbackMonths}
          hint="A record inside this window flags for staff to read - never an automatic decline (HUD 2016 guidance)."
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">Review</legend>
        <TextField
          label="Citation (optional)"
          name="citation"
          defaultValue={defaults.citation}
          error={errors.citation}
          hint="Criteria are owner policy, not statute - cite fair-housing guidance relied on, if any."
        />
        <TextField
          label="Reviewed by"
          name="reviewedBy"
          required
          error={errors.reviewedBy}
          hint="Required (OQ-6): the seeded placeholder criteria have never been reviewed by an attorney, and this is the record that they now have been."
        />
        <TextareaField
          label="Notes"
          name="notes"
          defaultValue={defaults.notes}
          error={errors.notes}
        />
      </fieldset>

      <SubmitButton label={submitLabel} />
    </form>
  )
}
