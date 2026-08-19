'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { NoticeToVacateFormState } from '@/lib/portal/notice-to-vacate-actions.ts'

export function NoticeToVacateForm({
  action,
}: {
  action: (
    state: NoticeToVacateFormState,
    formData: FormData,
  ) => Promise<NoticeToVacateFormState>
}) {
  const [state, formAction] = useActionState<NoticeToVacateFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />
      <TextField
        label="When do you plan to move out?"
        name="effectiveOn"
        type="date"
        required
        idPrefix="vacate"
        error={errors.effectiveOn}
      />
      <TextField
        label="Forwarding address"
        name="forwardingAddress"
        idPrefix="vacate"
        error={errors.forwardingAddress}
        hint="Where your deposit and any final paperwork should go. You can add this later if you don't have it yet."
      />
      <SubmitButton label="Give notice" />
    </form>
  )
}
