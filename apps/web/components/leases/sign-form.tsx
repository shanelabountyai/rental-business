'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
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

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />

      <TextField
        label="Type your full legal name"
        name="signedName"
        required
        hint={`This is how your name will appear on the signed ${what}.`}
      />

      <CheckboxField
        label={`I agree that typing my name above and submitting this form is my electronic signature on this ${what}.`}
        name="agree"
      />

      <SubmitButton label={`Sign this ${what}`} />
    </form>
  )
}
