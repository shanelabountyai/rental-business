'use client'

import { useActionState } from 'react'
import {
  FormAlerts,
  SubmitButton,
  useFocusWhen,
  useFormVersion,
} from '@/components/auth-form.tsx'
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
  // What was typed, handed back after a refusal, and the `key` that makes it
  // survive React 19's post-dispatch reset (R-114, `useFormVersion`). The
  // commonest refusal here is "give an email or a phone - at least one", the
  // very thing the hint under the field exists to prevent, and it used to
  // empty all five boxes. Somebody who has just lost their name, their number
  // and their message does not type them again.
  const echoed = state.values ?? {}
  const formVersion = useFormVersion(state)
  // R-107b converted this panel's `role="status"` to a `LiveRegion` and its
  // comment claimed the region was "mounted from first paint" - it was not.
  // The early `return` below replaces the whole form, so the region was a
  // brand-new node carrying its own text either way, which announces nothing.
  // A live region cannot help with a panel that replaces itself; focusing the
  // heading of what replaced it is what `useFocusWhen` is for, and it also
  // rescues the focus the unmounted submit button dropped on the floor.
  const sentHeading = useFocusWhen<HTMLHeadingElement>(Boolean(state.notice))

  if (state.notice) {
    return (
      <div className="flex flex-col gap-1 rounded-md border p-4">
        <h3 ref={sentHeading} tabIndex={-1} className="text-sm font-medium">
          Your message is on its way
        </h3>
        <p className="text-sm">{state.notice}</p>
      </div>
    )
  }

  return (
    <form key={formVersion} action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />
      <input type="hidden" name="source" value={source} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="First name"
          name="firstName"
          required
          idPrefix="inquiry"
          defaultValue={echoed.firstName}
          error={errors.firstName}
        />
        <TextField
          label="Last name"
          name="lastName"
          required
          idPrefix="inquiry"
          defaultValue={echoed.lastName}
          error={errors.lastName}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Email"
          name="email"
          type="email"
          idPrefix="inquiry"
          defaultValue={echoed.email}
          error={errors.email}
          hint="Give an email or a phone - at least one."
        />
        <TextField
          label="Phone"
          name="phone"
          type="tel"
          idPrefix="inquiry"
          defaultValue={echoed.phone}
        />
      </div>
      <TextareaField
        label="Anything you'd like us to know? (optional)"
        name="message"
        idPrefix="inquiry"
        rows={2}
        defaultValue={echoed.message}
      />
      {/* NOT "Ask about this listing" (R-114): that is verbatim the `<h2>`
          this form sits under, so the same words were announced twice on one
          page with two different roles. */}
      <SubmitButton label="Send my question" />
    </form>
  )
}
