'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { DocumentTemplateFormState } from '@/lib/documents/template-actions.ts'

export function RetireDocumentTemplateForm({
  action,
  active,
}: {
  action: (
    state: DocumentTemplateFormState,
    formData: FormData,
  ) => Promise<DocumentTemplateFormState>
  active: boolean
}) {
  const [state, formAction] = useActionState<DocumentTemplateFormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <SubmitButton label={active ? 'Retire' : 'Bring back into use'} />
    </form>
  )
}
