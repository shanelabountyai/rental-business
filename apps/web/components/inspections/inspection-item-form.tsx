'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { InspectionFormState } from '@/lib/inspections/actions.ts'

const CONDITION_OPTIONS = [
  { value: 'NEW', label: 'New' },
  { value: 'GOOD', label: 'Good' },
  { value: 'FAIR', label: 'Fair' },
  { value: 'POOR', label: 'Poor' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'MISSING', label: 'Missing' },
]

export function InspectionItemForm({
  action,
  itemId,
  room,
  item,
  condition,
  notes,
  editable,
}: {
  action: (
    state: InspectionFormState,
    formData: FormData,
  ) => Promise<InspectionFormState>
  itemId: string
  room: string
  item: string
  condition: string | null
  notes: string | null
  editable: boolean
}) {
  const [state, formAction] = useActionState<InspectionFormState, FormData>(action, {})

  if (!editable) {
    return (
      <li className="rounded-lg border p-3">
        <p className="font-medium">
          {room} — {item}
        </p>
        <p className="text-muted-foreground text-sm">
          {condition ? CONDITION_OPTIONS.find((c) => c.value === condition)?.label : 'Not recorded'}
          {notes && ` · ${notes}`}
        </p>
      </li>
    )
  }

  return (
    <li className="rounded-lg border p-3">
      <p className="font-medium">
        {room} — {item}
      </p>
      <form action={formAction} className="mt-2 flex flex-col gap-2">
        <FormAlerts state={state} />
        <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          <SelectField
            label="Condition"
            name="condition"
            required
            idPrefix={`item-${itemId}`}
            defaultValue={condition ?? undefined}
            error={state.fieldErrors?.condition}
            options={CONDITION_OPTIONS}
          />
          <TextField
            label="Notes"
            name="notes"
            idPrefix={`item-${itemId}`}
            defaultValue={notes ?? ''}
            error={state.fieldErrors?.notes}
          />
          <SubmitButton label="Save" />
        </div>
      </form>
    </li>
  )
}
