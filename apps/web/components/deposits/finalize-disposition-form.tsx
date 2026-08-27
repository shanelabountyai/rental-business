'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField, TextField } from '@/components/form/field.tsx'
import type { DepositFormState } from '@/lib/deposits/actions.ts'

// AN ACKNOWLEDGEMENT, BECAUSE THIS ONE CANNOT BE TAKEN BACK (R-116). The page
// says in prose "this cannot be undone once the letter exists", and the button
// next to that sentence fired on a single press with nothing in between - on
// the act that mints a statutory disposition letter and closes the deposit.
// `party-change-panel.tsx` already gates a comparable act this way.
//
// `required` on the box refuses in the BROWSER, before the round trip, which
// is what stops the gate from costing whoever hits it the forwarding address
// they just typed (React 19 resets an uncontrolled form on every dispatch).
// The action checks it too - that is the gate; this only makes it cheap.

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
      <CheckboxField
        label="I understand the letter is sent and cannot be undone"
        name="acknowledgeFinal"
        required
      />
      <SubmitButton label="Finalize disposition" />
    </form>
  )
}
