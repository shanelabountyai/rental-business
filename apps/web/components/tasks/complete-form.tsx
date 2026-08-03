'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/tasks/actions.ts'

/// The generic completion form every task type gets today: an optional note,
/// recorded as `proof: { note }`. No task type demands a typed proof shape
/// yet (PROOF_REQUIRED_TASK_TYPES starts empty - R-011 is built before its
/// first consumer, D-9), so there is nothing here for a real producer's own
/// completion UI to override yet either.
export function CompleteForm({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-4">
      <FormAlerts state={state} />
      <TextField
        label="Note (optional)"
        name="note"
        error={errors.proof}
        hint="What happened, for the record."
      />
      <SubmitButton label="Mark complete" />
    </form>
  )
}
