'use client'

import { useActionState } from 'react'
import { FieldError } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/notifications/actions.ts'

// One channel toggle for one category. A form per toggle rather than one big
// form with a save button: a preferences screen that silently loses a change
// because somebody navigated away without pressing Save is a preferences
// screen people stop trusting.
//
// Submitted on change, so `enabled` is carried as a hidden field rather than
// read off the checkbox - the checkbox reflects current state, and the value
// being submitted is the state being MOVED TO.
export function PreferenceToggle({
  category,
  channel,
  label,
  enabled,
  action,
}: {
  category: string
  channel: string
  label: string
  enabled: boolean
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const id = `pref-${category}-${channel}`

  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="category" value={category} />
      <input type="hidden" name="channel" value={channel} />
      {/*
        Named `enabled` and rendered as a checkbox so the browser submits
        "on" only when the box is checked - which is exactly the new value,
        because the click flips it before submission.
      */}
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          name="enabled"
          defaultChecked={enabled}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className="border-input size-5 rounded"
        />
        <span>{label}</span>
      </label>
      <FieldError id={`${id}-error`} message={state.error} />
    </form>
  )
}
