'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField } from '@/components/form/field.tsx'
import type { InspectionFormState } from '@/lib/inspections/actions.ts'

const TYPE_OPTIONS = [
  { value: 'MOVE_IN', label: 'Move-in' },
  { value: 'MOVE_OUT', label: 'Move-out' },
  { value: 'PRE_MOVE_OUT', label: 'Pre-move-out walkthrough' },
  { value: 'PERIODIC', label: 'Periodic' },
  { value: 'SEASONAL', label: 'Seasonal' },
  { value: 'DRIVE_BY', label: 'Drive-by' },
]

export function StartInspectionForm({
  action,
  units,
  templates,
}: {
  action: (
    state: InspectionFormState,
    formData: FormData,
  ) => Promise<InspectionFormState>
  units: readonly { id: string; label: string }[]
  templates: readonly { id: string; label: string }[]
}) {
  const [state, formAction] = useActionState<InspectionFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />
      <SelectField
        label="Unit"
        name="unitId"
        required
        idPrefix="inspection"
        error={errors.unitId}
        options={units.map((unit) => ({ value: unit.id, label: unit.label }))}
      />
      <SelectField
        label="Type"
        name="type"
        required
        idPrefix="inspection"
        error={errors.type}
        options={TYPE_OPTIONS}
      />
      <SelectField
        label="Checklist"
        name="templateId"
        required
        idPrefix="inspection"
        error={errors.templateId}
        options={templates.map((template) => ({ value: template.id, label: template.label }))}
      />
      <SubmitButton label="Start inspection" />
    </form>
  )
}
