'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError, SelectField } from '@/components/form/field.tsx'
import type { MaintenanceFormState } from '@/lib/maintenance/actions.ts'

const YES_NO_OPTIONS = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
]

/// One option per lease-tenant (not per lease), so a lease with more than
/// one tenant on it offers each by name rather than forcing staff to guess
/// which one is on the phone.
export interface LoggableCaller {
  id: string
  label: string
}

/// Staff's phone-side equivalent of the tenant maintenance wizard (R-019) -
/// same eventual Ticket shape (MAINT-01, R-022), free-text notes instead of
/// structured prompts because staff is writing up a live call, not
/// completing a form themselves.
export function LogPhoneRequestForm({
  action,
  callers,
  categories,
}: {
  action: (
    state: MaintenanceFormState,
    formData: FormData,
  ) => Promise<MaintenanceFormState>
  callers: readonly LoggableCaller[]
  categories: readonly { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<MaintenanceFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-5">
      <FormAlerts state={state} />
      <SelectField
        label="Who called"
        name="leaseTenantId"
        required
        defaultValue={callers.length === 1 ? callers[0]!.id : undefined}
        error={errors.leaseTenantId}
        options={callers.map((c) => ({ value: c.id, label: c.label }))}
      />
      <SelectField
        label="Category"
        name="category"
        required
        error={errors.category}
        options={categories}
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="field-phone-notes" className="text-sm font-medium">
          What they reported <span aria-hidden="true">*</span>
        </label>
        <textarea
          id="field-phone-notes"
          name="notes"
          rows={4}
          required
          aria-invalid={Boolean(errors.notes) || undefined}
          aria-describedby={errors.notes ? 'field-phone-notes-error' : undefined}
          className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none aria-invalid:border-red-500"
        />
        <FieldError id="field-phone-notes-error" message={errors.notes} />
      </div>
      <SelectField
        label="May we enter if they are not home?"
        name="entryPermission"
        required
        error={errors.entryPermission}
        options={YES_NO_OPTIONS}
      />
      <SelectField
        label="Is there a pet at home?"
        name="petWarning"
        required
        error={errors.petWarning}
        options={YES_NO_OPTIONS}
      />
      <SubmitButton label="Log request" />
    </form>
  )
}
