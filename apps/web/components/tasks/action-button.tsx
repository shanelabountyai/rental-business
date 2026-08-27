'use client'

import type { ReactNode } from 'react'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { FormState } from '@/lib/tasks/actions.ts'

/// A single-button form (claim, cancel) that still surfaces a returned error
/// - "someone else already claimed this" needs to reach the screen, so this
/// is a real useActionState form, not a bare `<form action={fn}>` whose
/// return value nothing would read.
export function TaskActionButton({
  action,
  label,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  /// `ReactNode`, not `string`, for the same reason `SubmitButton`'s own is
  /// (R-115): a per-row "Cancel"/"Remove" has to say WHICH row to assistive
  /// technology without printing the row's name a second time on screen.
  label: ReactNode
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <SubmitButton label={label} />
    </form>
  )
}
