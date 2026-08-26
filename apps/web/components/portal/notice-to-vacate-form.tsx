'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField, TextField } from '@/components/form/field.tsx'
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
      {/*
        THE ONLY IRREVERSIBLE THING A TENANT CAN DO HERE, and until R-111 it
        was two taps from a screen somebody might simply be browsing: two
        fields and a button, no confirmation, no undo. Every other
        irreversible action in this product - signing a lease, signing an
        inspection - already gates on an explicit agreement checkbox, and
        this is that same `agree` field with the same server-side check. The
        friction budget was being spent on what looks legally serious rather
        than on what is actually hardest to reverse.
      */}
      <CheckboxField
        label="I understand this ends my tenancy and cannot be undone here"
        name="agree"
        required
        hint="If you change your mind, you will need to contact us - the date above is what we will plan the move-out around."
      />
      <SubmitButton label="Give notice" />
    </form>
  )
}
