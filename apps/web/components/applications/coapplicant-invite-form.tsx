'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { ApplicantFormState } from '@/lib/applications/actions.ts'

// The lead adds a co-applicant (LEASE-03, R-059) - name plus an email or a
// phone, that's all: everything else is THEIR own form, at their own link.

export function CoApplicantInviteForm({
  action,
}: {
  action: (state: ApplicantFormState, formData: FormData) => Promise<ApplicantFormState>
}) {
  const [state, formAction] = useActionState<ApplicantFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="First name"
          name="firstName"
          required
          idPrefix="coapplicant"
          error={errors.firstName}
        />
        <TextField
          label="Last name"
          name="lastName"
          required
          idPrefix="coapplicant"
          error={errors.lastName}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Email"
          name="email"
          type="email"
          idPrefix="coapplicant"
          error={errors.email}
          hint="Give an email or a phone - that's how their link gets sent."
        />
        <TextField label="Phone" name="phone" type="tel" idPrefix="coapplicant" />
      </div>
      <SubmitButton label="Add co-applicant" />
    </form>
  )
}
