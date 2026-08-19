'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField } from '@/components/form/field.tsx'
import type { InspectionSignFormState } from '@/lib/portal/inspection-actions.ts'

export function InspectionSignForm({
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
      <CheckboxField label="I've reviewed this report and it looks right to me" name="agree" />
      <SubmitButton label="Sign" />
    </form>
  )
}
