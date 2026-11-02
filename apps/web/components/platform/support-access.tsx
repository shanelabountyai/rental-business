'use client'

import { useActionState, useEffect } from 'react'
import { DEFAULT_REQUEST_MINUTES, REQUEST_MINUTES, durationLabel } from '@rental/core/rbac'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextareaField } from '@/components/form/field.tsx'
import type { SupportGrantFormState } from '@/lib/platform/support-actions.ts'

// `/platform/orgs/[slug]/support` and `/platform/grants` (PRD 11 §4.7, R-295a).

type Action = (state: SupportGrantFormState, formData: FormData) => Promise<SupportGrantFormState>

export function RequestAccessForm({ action, slug }: { action: Action; slug: string }) {
  const [state, formAction] = useActionState<SupportGrantFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  return (
    <section aria-labelledby="request-heading" className="flex flex-col gap-3 rounded-md border p-4 text-sm">
      <h2 id="request-heading" className="text-lg font-semibold">
        Request access
      </h2>
      <p>The owners are asked, and nothing opens until one of them approves. They read your reason word for word.</p>
      <FormAlerts state={state} />
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="slug" value={slug} />
        <TextareaField label="Reason for the request" name="reason" required error={errors.reason} hint="At least 20 characters." rows={3} idPrefix="request" />
        <SelectField
          label="How long"
          name="minutes"
          required
          defaultValue={String(DEFAULT_REQUEST_MINUTES)}
          error={errors.minutes}
          idPrefix="request"
          options={REQUEST_MINUTES.map((m) => ({ value: String(m), label: durationLabel(m) }))}
        />
        <SubmitButton label="Request access" />
      </form>
    </section>
  )
}

export function BreakGlassForm({ action, slug }: { action: Action; slug: string }) {
  const [state, formAction] = useActionState<SupportGrantFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  return (
    <section aria-labelledby="break-glass-heading" className="flex flex-col gap-3 rounded-md border p-4 text-sm">
      <h2 id="break-glass-heading" className="text-lg font-semibold">
        Emergency access (break-glass)
      </h2>
      <p>
        Opens at once for 60 minutes, read-only, with no approval. Every owner is told at once and their dashboard
        says so until one of them marks it seen. It asks for a fresh code.
      </p>
      <FormAlerts state={state} />
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="slug" value={slug} />
        <TextareaField label="Reason for emergency access" name="reason" required error={errors.breakGlassReason} rows={3} idPrefix="break-glass" />
        <SubmitButton label="Open emergency access" />
      </form>
    </section>
  )
}

/// One per open grant, labelled with its org so two never share a name.
export function EndGrantButton({ action, grantId, label }: { action: Action; grantId: string; label: string }) {
  const [state, formAction] = useActionState<SupportGrantFormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <input type="hidden" name="grantId" value={grantId} />
      <SubmitButton label={label} />
    </form>
  )
}

/// "Open" (R-295b): the action answers with the org host's entry link and the
/// browser follows it as a full navigation, since it is another host.
export function OpenGrantButton({ action, grantId, label }: { action: Action; grantId: string; label: string }) {
  const [state, formAction] = useActionState<SupportGrantFormState, FormData>(action, {})
  useEffect(() => {
    if (state.openUrl) window.location.assign(state.openUrl)
  }, [state])
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <input type="hidden" name="grantId" value={grantId} />
      <SubmitButton label={label} />
    </form>
  )
}
