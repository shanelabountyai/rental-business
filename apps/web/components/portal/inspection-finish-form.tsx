'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { InspectionSignFormState } from '@/lib/portal/inspection-actions.ts'

/// Mirrors InspectionSignForm's own shape exactly (INSP-05, R-074) - a
/// single-button form with no fields of its own, just a different label and
/// a different action bound to it (`finishInspectionAsTenant` rather than
/// `signInspectionAsTenant`).
export function InspectionFinishForm({
  action,
}: {
  action: (
    state: InspectionSignFormState,
    formData: FormData,
  ) => Promise<InspectionSignFormState>
}) {
  const [state, formAction] = useActionState<InspectionSignFormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />
      <SubmitButton label="Finish walkthrough" />
    </form>
  )
}
