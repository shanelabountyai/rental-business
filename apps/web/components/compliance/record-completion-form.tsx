'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { ComplianceFormState } from '@/lib/compliance/actions.ts'

export function RecordCompletionForm({
  action,
}: {
  action: (state: ComplianceFormState, formData: FormData) => Promise<ComplianceFormState>
}) {
  const [state, formAction] = useActionState<ComplianceFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} encType="multipart/form-data" className="flex flex-col gap-4">
      <FormAlerts state={state} />
      <TextField label="Completed on" name="completedOn" type="date" required error={errors.completedOn} />
      <TextField label="Notes (optional)" name="notes" error={errors.notes} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="completion-file" className="text-sm font-medium">
          Proof (optional)
        </label>
        <input id="completion-file" type="file" name="file" className="text-sm" />
      </div>
      <SubmitButton label="Record completion" />
    </form>
  )
}
