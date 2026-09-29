'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton, useFormVersion } from '@/components/auth-form.tsx'
import { CheckboxField, TextField } from '@/components/form/field.tsx'
import type { SignFormState } from '@/lib/leases/esign-actions.ts'

// One signer's own sign-the-lease form (LEASE-06, R-063).
//
// A REAL `<form action>`, not a button with a handler - the same rule every
// other public, must-work-on-first-paint form in this product follows
// (PayForm's own header states it). A typed full legal name plus an
// explicit agreement checkbox is the whole ceremony - this is a simulated
// provider (D-7), and the product defines what "signing" means since no
// real vendor's hosted flow exists to copy.

export function SignForm({
  what,
  action,
}: {
  /// What is being signed, in the words `signedThing()` chose - "lease",
  /// "change to the lease", "repayment plan" (R-203). Every sentence on this
  /// form reads it, so a repayment agreement can never present itself as a
  /// lease to somebody about to type their legal name on it.
  what: string
  action: (state: SignFormState, formData: FormData) => Promise<SignFormState>
}) {
  const [state, formAction] = useActionState<SignFormState, FormData>(action, {})
  // What was typed, handed back after a refusal, and the `key` that makes it
  // survive React 19's post-dispatch reset (R-114, `useFormVersion`).
  const echoed = state.values ?? {}
  const formVersion = useFormVersion(state)

  return (
    <div className="flex flex-col gap-5">
      <FormAlerts state={state} />

      <form key={formVersion} action={formAction} className="flex flex-col gap-5">
        <TextField
          label="Type your full legal name"
          name="signedName"
          required
          defaultValue={echoed.signedName}
          hint={`This is how your name will appear on the signed ${what}.`}
        />

        <CheckboxField
          label={`I agree that typing my name above and submitting this form is my electronic signature on this ${what}.`}
          name="agree"
          required
        />

        <SubmitButton label={`Sign this ${what}`} />
      </form>
    </div>
  )
}
