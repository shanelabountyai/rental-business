'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { FormState } from '@/lib/documents/actions.ts'

export function RestoreButton({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex items-center gap-2">
      <FormAlerts state={state} />
      <SubmitButton label="Restore" />
    </form>
  )
}
