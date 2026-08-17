'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { FormState } from '@/lib/listings/actions.ts'

// Publish/unpublish (LEASE-01, R-056) - two one-button forms, same shape as
// lifecycle-panel.tsx's TransitionForm, so each has its own pending state
// and its own error region rather than sharing one with the terms form.

type Action = (state: FormState, formData: FormData) => Promise<FormState>

function ControlForm({ action, label }: { action: Action; label: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <SubmitButton label={label} />
    </form>
  )
}

export function ListingPublishControls({
  status,
  publish,
  unpublish,
}: {
  status: string
  publish: Action
  unpublish: Action
}) {
  if (status === 'PUBLISHED') {
    return (
      <ControlForm
        action={unpublish}
        label="Unpublish (take the public page down)"
      />
    )
  }
  return <ControlForm action={publish} label="Publish" />
}
