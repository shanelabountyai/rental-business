'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { InspectionTemplateFormState } from '@/lib/inspections/template-actions.ts'

type Action = (
  state: InspectionTemplateFormState,
  formData: FormData,
) => Promise<InspectionTemplateFormState>

/// A fixed, generous number of blank row slots, rather than a client-side
/// "Add item" button - CLAUDE.md's own documented trap: onClick is inert
/// until hydration, and a Playwright click (or a real person tapping fast
/// on a slow connection) landing before that moment is a silent no-op with
/// nothing to show for it. An empty slot is simply dropped by
/// `readChecklistItems()` when the form is submitted, so this costs nothing
/// unused and needs no client JS to work at all.
const BLANK_ROWS = 8

export function InspectionTemplateForm({
  action,
  defaultName = '',
  defaultItems = [],
}: {
  action: Action
  defaultName?: string
  defaultItems?: readonly { room: string; item: string }[]
}) {
  const [state, formAction] = useActionState<InspectionTemplateFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  const rowCount = Math.max(defaultItems.length + BLANK_ROWS, BLANK_ROWS)
  const rows = Array.from({ length: rowCount }, (_, index) => defaultItems[index] ?? { room: '', item: '' })

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />
      <TextField label="Name" name="name" required idPrefix="checklist" defaultValue={defaultName} error={errors.name} />

      <div className="flex flex-col gap-4">
        <p className="text-sm font-medium">Checklist</p>
        <p className="text-muted-foreground text-sm">
          One room and item per row. Leave a row blank to skip it - extra blank rows below
          are there for whatever you add later.
        </p>
        {errors.items && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {errors.items}
          </p>
        )}
        {rows.map((row, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-md border p-3">
            <TextField
              label="Room"
              name="room"
              defaultValue={row.room}
              idPrefix={`checklist-row-${index}`}
              error={errors[`items.${index}.room`]}
            />
            <TextField
              label="Item"
              name="item"
              defaultValue={row.item}
              idPrefix={`checklist-row-${index}`}
              error={errors[`items.${index}.item`]}
            />
          </div>
        ))}
      </div>

      <SubmitButton label="Save" />
    </form>
  )
}
