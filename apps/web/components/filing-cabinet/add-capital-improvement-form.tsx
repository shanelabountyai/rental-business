'use client'

import { CAPITAL_IMPROVEMENT_CATEGORIES } from '@rental/core/tax'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/filing-cabinet/actions.ts'

const CATEGORY_LABELS: Record<string, string> = {
  ROOF: 'Roof',
  HVAC: 'HVAC',
  WATER_HEATER: 'Water heater',
  PLUMBING: 'Plumbing',
  ELECTRICAL: 'Electrical',
  WINDOWS: 'Windows and doors',
  FLOORING: 'Flooring',
  APPLIANCE: 'Appliance',
  STRUCTURE: 'Structure and foundation',
  EXTERIOR: 'Exterior and siding',
  LANDSCAPE: 'Landscaping and site work',
  OTHER: 'Other',
}

export function AddCapitalImprovementForm({
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
        label="Component"
        name="category"
        idPrefix="capex"
        required
        error={errors.category}
        options={CAPITAL_IMPROVEMENT_CATEGORIES.map((c) => ({
          value: c,
          label: CATEGORY_LABELS[c] ?? c,
        }))}
      />
      <TextField
        label="What was done"
        name="description"
        idPrefix="capex"
        required
        error={errors.description}
        hint="Specific enough to recognise in three years — “full tear-off, architectural shingle”."
      />
      <TextField
        label="Project cost"
        name="costDollars"
        idPrefix="capex"
        type="number"
        required
        error={errors.costDollars}
        hint="Whole dollars, everything capitalised into the project."
      />
      <TextField
        label="Placed in service on"
        name="inServiceOn"
        idPrefix="capex"
        type="date"
        required={false}
        error={errors.inServiceOn}
        hint="The day it was first available for use, which starts depreciation — not the invoice date. Leave blank if unknown; the tax export will flag it rather than guess."
      />
      <TextField
        label="Work order ID"
        name="workOrderId"
        idPrefix="capex"
        required={false}
        error={errors.workOrderId}
        hint="Optional. If the project ran through maintenance, linking it stops the same money being deducted as a repair as well."
      />
      <TextField label="Notes" name="notes" idPrefix="capex" required={false} error={errors.notes} />
      <SubmitButton label="Add improvement" />
    </form>
  )
}
