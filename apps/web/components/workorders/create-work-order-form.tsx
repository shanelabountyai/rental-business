'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError, SelectField, TextField } from '@/components/form/field.tsx'
import type { WorkOrderFormState } from '@/lib/workorders/actions.ts'

const PRIORITY_OPTIONS = [
  { value: 'URGENT', label: 'Urgent' },
  { value: 'ROUTINE', label: 'Routine' },
  { value: 'EMERGENCY', label: 'Emergency' },
]

export interface WarrantyContext {
  id: string
  label: string
  isLikelyMatch: boolean
}

/**
 * Creates a work order (MAINT-03) - from a ticket, whose property/unit/
 * category come from the server rather than a client-editable field, or
 * standalone (a make-ready turn has no ticket behind it), where a unit
 * picker takes their place.
 */
export function CreateWorkOrderForm({
  action,
  ticketId,
  ticketSummary,
  units,
  warranties,
}: {
  action: (state: WorkOrderFormState, formData: FormData) => Promise<WorkOrderFormState>
  ticketId?: string
  ticketSummary?: string
  units: readonly { id: string; label: string }[]
  warranties: readonly WarrantyContext[]
}) {
  const [state, formAction] = useActionState<WorkOrderFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-5">
      <FormAlerts state={state} />

      {ticketId ? (
        <>
          <input type="hidden" name="ticketId" value={ticketId} />
          {ticketSummary && (
            <p className="text-muted-foreground text-sm">From ticket: {ticketSummary}</p>
          )}
        </>
      ) : (
        <SelectField
          label="Unit"
          name="unitId"
          required
          error={errors.unitId}
          options={units.map((u) => ({ value: u.id, label: u.label }))}
        />
      )}

      {warranties.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <p className="font-medium">Warranty status (PROP-06)</p>
          {warranties.map((w) => (
            <p key={w.id} className={w.isLikelyMatch ? 'font-medium' : 'text-muted-foreground'}>
              {w.label}
              {w.isLikelyMatch && ' — likely covers this'}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="field-wo-scope" className="text-sm font-medium">
          Scope of work <span aria-hidden="true">*</span>
        </label>
        <textarea
          id="field-wo-scope"
          name="scope"
          rows={4}
          required
          aria-invalid={Boolean(errors.scope) || undefined}
          aria-describedby={errors.scope ? 'field-wo-scope-error' : undefined}
          className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none aria-invalid:border-red-500"
        />
        <FieldError id="field-wo-scope-error" message={errors.scope} />
      </div>

      <SelectField
        label="Priority"
        name="priority"
        required
        defaultValue="ROUTINE"
        error={errors.priority}
        options={PRIORITY_OPTIONS}
      />

      <TextField
        label="Cost estimate (optional)"
        name="estimateDollars"
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        error={errors.estimateCents}
        hint="Whole or fractional dollars. Leave blank if you don't have one yet."
      />

      {warranties.length > 0 && (
        <div className="flex items-start gap-2">
          <input
            id="field-wo-warrantyClaim"
            name="warrantyClaim"
            type="checkbox"
            value="true"
            className="border-input mt-1 size-5 rounded"
          />
          <label htmlFor="field-wo-warrantyClaim" className="text-sm">
            This is a warranty claim
          </label>
        </div>
      )}

      <SubmitButton label="Create work order" />
    </form>
  )
}
