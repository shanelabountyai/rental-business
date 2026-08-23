'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { AbandonmentFormState } from '@/lib/abandonment/actions.ts'

// Opening a gone-dark case from the tenancy it is about (RISK-01, R-087).
//
// Behind a `<details>`, closed by default, and that is not just tidiness: on
// a lease page full of ordinary controls this is the one that starts a path
// ending in somebody's home being entered. It should take a deliberate click
// to find, not sit under the cursor beside "add a recurring charge".

export function OpenAbandonmentCasePanel({
  action,
  existing,
}: {
  action: (state: AbandonmentFormState, formData: FormData) => Promise<AbandonmentFormState>
  /// An open case, when there is one — the panel then points at it rather
  /// than offering to open a second.
  existing: { id: string; status: string } | null
}) {
  const [state, formAction] = useActionState<AbandonmentFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="gone-dark" className="flex flex-col gap-3 border-t pt-4">
      <h2 id="gone-dark" className="text-lg font-semibold">
        Tenant gone dark
      </h2>

      {existing ? (
        <p className="text-sm">
          There is an open case on this tenancy.{' '}
          <a href={`/abandonment/${existing.id}`} className="underline underline-offset-2">
            Open it
          </a>
          .
        </p>
      ) : (
        <details className="rounded-md border p-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
            Open a gone-dark case
          </summary>
          <div className="flex flex-col gap-3 pt-3">
            <p className="text-muted-foreground text-sm">
              For a tenancy that has stopped answering. Opening a case does not
              declare the home abandoned and does not let anybody into it — it
              starts the record of what was tried, which is the thing that
              protects you if you do end up going in.
            </p>
            <form action={formAction} className="flex flex-col gap-3">
              <FormAlerts state={state} />
              <TextField
                label="Why do you think they have gone?"
                name="reason"
                required
                idPrefix="gone-dark"
                error={errors.reason}
                hint="Rent stopped, calls unanswered, a neighbour said the car has not moved. This is the first question asked afterwards."
              />
              <TextField
                label="Last sign of them"
                name="lastContactOn"
                type="date"
                idPrefix="gone-dark"
                error={errors.lastContactOn}
                hint="A payment, a message, a sighting. The silence clock measures from it."
              />
              <SubmitButton label="Open the case" />
            </form>
          </div>
        </details>
      )}
    </section>
  )
}
