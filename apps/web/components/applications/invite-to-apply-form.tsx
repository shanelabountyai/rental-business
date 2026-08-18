'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { InviteFormState } from '@/lib/applications/staff-actions.ts'

export function InviteToApplyForm({
  action,
}: {
  action: (state: InviteFormState, formData: FormData) => Promise<InviteFormState>
}) {
  const [state, formAction] = useActionState<InviteFormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <SubmitButton label="Invite to apply" />
    </form>
  )
}
