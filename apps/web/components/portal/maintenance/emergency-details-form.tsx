'use client'

import type { EmergencyCategory } from '@rental/core/maintenance'
import { useActionState } from 'react'
import { LiveRegion } from '@/components/auth-form.tsx'
import type { EmergencyFormState } from '@/lib/maintenance/actions.ts'

// The last step of the emergency path (MAINT-01, R-020, R-098).
//
// ONLY THIS STEP IS A CLIENT COMPONENT. Choosing what is happening and
// reading "do this now" are server-rendered and URL-driven, so the safety
// instructions exist on first paint whether or not JavaScript has arrived —
// which is the whole point of R-020 and was not true before: the whole flow
// was `useState`, so a tenant who could smell gas on a weak connection tapped
// a category and got nothing at all.
//
// A real `<form action>` + `useActionState`. The two questions are radios
// rather than toggle buttons: a screen reader announces the chosen answer,
// they work before hydration, and the browser enforces one-of-each without
// any state to keep.

const RADIO_LABEL =
  'focus-within:ring-ring flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-md border px-4 py-2 text-base focus-within:ring-2 focus-within:ring-offset-2 has-[:checked]:border-foreground has-[:checked]:bg-secondary has-[:checked]:font-medium'

function YesNo({ name, legend }: { name: string; legend: string }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-medium">{legend}</legend>
      <div className="flex flex-col gap-2">
        {[
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          // A THIRD ANSWER, and nothing pre-selected. The previous version disabled
          // "Send now" until both questions were answered — so at 2am with
          // sewage rising, two questions stood between a tenant and paging
          // somebody. An unknown answer is recorded as unknown, the same way
          // R-030 records an unanswered verification rather than blocking on
          // it. Nothing is pre-checked either: defaulting would put an
          // answer in the tenant's mouth that whoever responds would rely on.
          { value: 'unknown', label: 'I am not sure' },
        ].map((option) => (
          <label key={option.value} className={RADIO_LABEL}>
            <input
              type="radio"
              name={name}
              value={option.value}
              className="size-5"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function EmergencyDetailsForm({
  category,
  categoryLabel,
  action,
}: {
  category: EmergencyCategory
  categoryLabel: string
  action: (state: EmergencyFormState, formData: FormData) => Promise<EmergencyFormState>
}) {
  const [state, formAction] = useActionState<EmergencyFormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="category" value={category} />

      <LiveRegion assertive>
        {state.error && <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-base text-red-900">{state.error}</p>}
      </LiveRegion>

      <h2 className="text-lg font-semibold">{categoryLabel}</h2>

      <YesNo name="entryPermission" legend="Can we come in if you are not home?" />
      <YesNo name="petWarning" legend="Is there a pet at home?" />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="emergency-detail" className="font-medium">
          Anything else we should know? (optional)
        </label>
        <textarea
          id="emergency-detail"
          name="detail"
          rows={3}
          className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        />
      </div>

      <button
        type="submit"
        className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-12 items-center justify-center rounded-md px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        Send now
      </button>
    </form>
  )
}
