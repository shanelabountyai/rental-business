'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/comms/actions.ts'

// COMM-01: "staff phone calls are logged as timestamped call notes in the
// same thread (contemporaneous notes carry legal weight)."
//
// The time defaults to now but is editable, because the realistic flow is
// writing up a call ten minutes after hanging up. Forcing the note's
// timestamp to be the typing time would misdate the evidence in the one
// direction that matters - a note dated later than the call it describes is
// easier to attack as reconstructed.
export function LogCallForm({
  action,
  defaultOccurredAt,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  /// `datetime-local` format, computed on the server so the markup does not
  /// depend on the client clock and hydration cannot mismatch.
  defaultOccurredAt: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-3 sm:max-w-md">
      <FormAlerts state={state} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="field-call-body" className="text-sm font-medium">
          What was said
        </label>
        <textarea
          id="field-call-body"
          name="body"
          rows={3}
          required
          aria-invalid={Boolean(errors.body) || undefined}
          aria-describedby={errors.body ? 'field-call-body-error' : undefined}
          className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none aria-invalid:border-red-500"
        />
        {errors.body && (
          <p
            id="field-call-body-error"
            role="alert"
            className="text-sm text-red-700 dark:text-red-400"
          >
            {errors.body}
          </p>
        )}
      </div>
      <TextField
        label="When the call happened"
        name="occurredAt"
        idPrefix="call"
        type="datetime-local"
        required
        defaultValue={defaultOccurredAt}
        error={errors.occurredAt}
      />
      <SubmitButton label="Log call" />
    </form>
  )
}
