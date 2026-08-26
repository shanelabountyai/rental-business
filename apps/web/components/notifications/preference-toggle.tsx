'use client'

import { useActionState } from 'react'
import { pendingButtonProps } from '@/components/auth-form.tsx'
import { FieldError } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/notifications/actions.ts'

// One channel toggle for one category. A form per toggle rather than one big
// form with a save button: a preferences screen that silently loses a change
// because somebody navigated away without pressing Save is a preferences
// screen people stop trusting.
//
// ==========================================================================
// A SUBMIT BUTTON, NOT A CHECKBOX THAT SUBMITS ITSELF (R-115).
//
// It was `<input type="checkbox" onChange={e => e.currentTarget.form
// ?.requestSubmit()}>` with no submit button in the form at all. Before
// hydration - which on this screen means the whole first paint - the box
// flipped under the finger and nothing was saved: the one failure mode worse
// than a control that does nothing is a control that LOOKS like it did
// something. There was nothing to announce afterwards either, because the
// checkbox's own state is what the browser flipped and the server's answer
// never reached it.
//
// A `<button type="submit" name="enabled">` posts whether or not React has
// arrived, carries the value being MOVED TO in its own `value` (the checkbox
// comment below used to explain the same trick), and - because it keeps focus
// through the submit, which is what `pendingButtonProps` is for - a screen
// reader announces the `aria-pressed` flip when the server's answer lands.
// No Save button, no lost change, and nothing to hydrate.
// ==========================================================================
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
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {})
  const id = `pref-${category}-${channel}`

  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="category" value={category} />
      <input type="hidden" name="channel" value={channel} />
      <button
        id={id}
        type="submit"
        name="enabled"
        value={enabled ? 'off' : 'on'}
        aria-pressed={enabled}
        aria-describedby={state.error ? `${id}-error` : undefined}
        {...pendingButtonProps(pending)}
        className="border-input focus-visible:ring-ring aria-pressed:bg-foreground aria-pressed:text-background min-h-11 rounded-md border px-3 text-sm aria-disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        {label}
      </button>
      <FieldError id={`${id}-error`} message={state.error} />
    </form>
  )
}
