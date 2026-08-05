'use client'

import { APPLIANCE_CATEGORIES } from '@rental/core/operational'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/operational/actions.ts'

const CATEGORY_LABELS: Record<string, string> = {
  REFRIGERATOR: 'Refrigerator',
  RANGE: 'Range',
  DISHWASHER: 'Dishwasher',
  WASHER: 'Washer',
  DRYER: 'Dryer',
  WATER_HEATER: 'Water heater',
  HVAC: 'HVAC',
  MICROWAVE: 'Microwave',
  OTHER: 'Other',
}

export function AddApplianceForm({
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
        idPrefix="appliance"
        required
        error={errors.category}
        options={APPLIANCE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c }))}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField label="Make" name="make" idPrefix="appliance" required={false} error={errors.make} />
        <TextField label="Model" name="model" idPrefix="appliance" required={false} error={errors.model} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Serial number"
          name="serialNumber"
          idPrefix="appliance"
          required={false}
          error={errors.serialNumber}
        />
        <TextField
          label="Installed on"
          name="installedOn"
          idPrefix="appliance"
          type="date"
          required={false}
          error={errors.installedOn}
        />
      </div>
      <TextField
        label="Filter size (HVAC only)"
        name="filterSize"
        idPrefix="appliance"
        required={false}
        error={errors.filterSize}
        hint='"16x25x1"'
      />
      <TextField label="Notes" name="notes" idPrefix="appliance" required={false} error={errors.notes} />
      <SubmitButton label="Add appliance" />
    </form>
  )
}
