'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { PreventiveFormState } from '@/lib/maintenance/preventive-actions.ts'

/// "One action creates the batch across properties" (MAINT-08) - a single
/// button, not a form with fields, but still a real useActionState form so
/// the count-created/auto-assigned summary has somewhere to land.
export function RunBatchButton({
  action,
  dueCount,
}: {
  action: (state: PreventiveFormState, formData: FormData) => Promise<PreventiveFormState>
  dueCount: number
}) {
  const [state, formAction] = useActionState<PreventiveFormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <SubmitButton label={dueCount === 0 ? 'Nothing due' : `Run batch (${dueCount} due)`} />
    </form>
  )
}
