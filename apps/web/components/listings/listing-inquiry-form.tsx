'use client'

import { useActionState } from 'react'
import { FormAlerts, LiveRegion, SubmitButton } from '@/components/auth-form.tsx'
import { TextField, TextareaField } from '@/components/form/field.tsx'
import type { InquiryFormState } from '@/lib/prospects/actions.ts'

// The public inquiry form (LEASE-07, R-058) - what turns an anonymous
// ListingLead visit into a named Prospect. `source` rides along as a
// hidden field so the same network attribution the visit already carried
// (R-057's `?src=`) survives onto the Prospect record.

export function ListingInquiryForm({
  action,
  source,
}: {
  action: (state: InquiryFormState, formData: FormData) => Promise<InquiryFormState>
  source: string
}) {
  const [state, formAction] = useActionState<InquiryFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  // The confirmation used to be an early `return` that replaced the form with
  // an already-populated `role="status"`, which announces nothing (R-101). The
  // region is mounted from first paint and the form hides under it instead.
  if (state.notice) {
    return (
      <LiveRegion>
        <div className="rounded-md border p-4 text-sm">{state.notice}</div>
      </LiveRegion>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />
      <input type="hidden" name="source" value={source} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="First name"
          name="firstName"
          required
          idPrefix="inquiry"
          error={errors.firstName}
        />
        <TextField
          label="Last name"
          name="lastName"
          required
          idPrefix="inquiry"
          error={errors.lastName}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Email"
          name="email"
          type="email"
          idPrefix="inquiry"
          error={errors.email}
          hint="Give an email or a phone - at least one."
        />
        <TextField label="Phone" name="phone" type="tel" idPrefix="inquiry" />
      </div>
      <TextareaField label="Anything you'd like us to know? (optional)" name="message" idPrefix="inquiry" rows={2} />
      <SubmitButton label="Ask about this listing" />
    </form>
  )
}
