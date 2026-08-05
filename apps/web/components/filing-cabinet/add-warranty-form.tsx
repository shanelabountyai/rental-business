'use client'

import { WARRANTY_CATEGORIES } from '@rental/core/filing-cabinet'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/filing-cabinet/actions.ts'

const CATEGORY_LABELS: Record<string, string> = {
  ROOF: 'Roof',
  HVAC: 'HVAC',
  WATER_HEATER: 'Water heater',
  APPLIANCE: 'Appliance',
  HOME_WARRANTY: 'Home warranty',
  OTHER: 'Other',
}

export function AddWarrantyForm({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-4 sm:max-w-md">
      <FormAlerts state={state} />
      <SelectField
        label="Category"
        name="category"
        idPrefix="warranty"
        required
        error={errors.category}
        options={WARRANTY_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c }))}
      />
      <TextField label="Provider" name="provider" idPrefix="warranty" required error={errors.provider} />
      <TextField
        label="Coverage summary"
        name="coverageSummary"
        idPrefix="warranty"
        required={false}
        error={errors.coverageSummary}
      />
      <TextField
        label="Expires on"
        name="expiresOn"
        idPrefix="warranty"
        type="date"
        required={false}
        error={errors.expiresOn}
        hint="Leave blank if unknown - a work order will treat this as unknown coverage, not no coverage."
      />
      <TextField label="Notes" name="notes" idPrefix="warranty" required={false} error={errors.notes} />
      <SubmitButton label="Add warranty" />
    </form>
  )
}
