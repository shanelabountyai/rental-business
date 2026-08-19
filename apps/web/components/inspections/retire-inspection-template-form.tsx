'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { InspectionTemplateFormState } from '@/lib/inspections/template-actions.ts'

export function RetireInspectionTemplateForm({
  action,
  active,
}: {
  action: (
    state: InspectionTemplateFormState,
    formData: FormData,
  ) => Promise<InspectionTemplateFormState>
  active: boolean
}) {
  const [state, formAction] = useActionState<InspectionTemplateFormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <SubmitButton label={active ? 'Retire' : 'Bring back into use'} />
    </form>
  )
}
