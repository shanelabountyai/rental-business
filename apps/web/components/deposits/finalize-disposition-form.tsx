'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { DepositFormState } from '@/lib/deposits/actions.ts'

export function FinalizeDispositionForm({
  action,
  defaultForwardingAddress,
}: {
  action: (state: DepositFormState, formData: FormData) => Promise<DepositFormState>
  defaultForwardingAddress: string
}) {
  const [state, formAction] = useActionState<DepositFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <TextField
        label="Forwarding address"
        name="forwardingAddress"
        required
        defaultValue={defaultForwardingAddress}
        error={errors.forwardingAddress}
      />
      <SubmitButton label="Finalize disposition" />
    </form>
  )
}
