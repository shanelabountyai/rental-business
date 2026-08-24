'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { AccessFormState } from '@/lib/showings/access-actions.ts'

// The prospect's confirm-who-you-are step (LEASE-08, R-094).
//
// IT ASKS FOR A NAME, NOT A PHOTO, and the difference is the whole of D-108
// applied to a stranger: an uploaded ID would become a `Document` readable
// by every member of staff who can read documents at all, including
// maintenance, and would sit there for ever. The provider sees the document;
// this product records that a check happened and what name came back.

export function SelfShowingIdentityForm({
  action,
}: {
  action: (state: AccessFormState, formData: FormData) => Promise<AccessFormState>
}) {
  const [state, submit] = useActionState<AccessFormState, FormData>(action, {})

  return (
    <form action={submit} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <p className="text-sm">
        Before we can give you an entry code we need to check who you are. Have your driving
        licence or passport to hand — please do this now rather than on the doorstep.
      </p>
      <TextField
        label="Your name exactly as it is printed on your photo ID"
        name="documentName"
        required
        idPrefix="self-showing"
        error={state.fieldErrors?.documentName}
        hint="It has to match the name this viewing was booked under. If it does not — a married name, a shortened first name — call the office instead and they will sort it out."
      />
      <p className="text-muted-foreground text-sm">
        We do not keep a copy of your ID. We record that the check was done, when, and the name
        on the document.
      </p>
      <SubmitButton label="Confirm who I am" />
    </form>
  )
}
