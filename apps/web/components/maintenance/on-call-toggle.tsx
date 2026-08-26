'use client'

import { ON_CALL_SHIFT_HOURS } from '@rental/core/oncall'
import { useActionState } from 'react'
import { LiveRegion } from '@/components/auth-form.tsx'
import type { OnCallFormState } from '@/lib/oncall/actions.ts'

// The on-call toggle (MAINT-12, R-029).
//
// Two taps at most, on the screen a staff member already has open. Somebody
// picking up a weekend shift does it from a phone in a car park, and a rota
// that needs a date picker is a rota that stays empty - which routes every
// emergency to everybody, forever.
//
// REAL FORM SUBMISSIONS, not onClick handlers. A handler does nothing until
// React has hydrated; a form posts whether or not it has. Every button here
// works on a bad connection before the JavaScript arrives.

export function OnCallToggle({
  onCallUntil,
  setOnCall,
}: {
  onCallUntil: string | null
  setOnCall: (
    previous: OnCallFormState,
    formData: FormData,
  ) => Promise<OnCallFormState>
}) {
  const [state, action, pending] = useActionState<OnCallFormState, FormData>(
    setOnCall,
    {},
  )

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm" role="status">
        {onCallUntil ? (
          <>
            You are <strong>on call</strong> until {onCallUntil}. Emergencies at
            your properties page you, and nobody else, until it lapses.
          </>
        ) : (
          <>
            You are <strong>not on call</strong>. While nobody is on call for a
            property, an emergency there pages everybody who can act on it —
            which is safe, but loud.
          </>
        )}
      </p>

      <form action={action} className="flex flex-wrap gap-2">
        {ON_CALL_SHIFT_HOURS.map((hours) => (
          <button
            key={hours}
            type="submit"
            name="hours"
            value={String(hours)}
            disabled={pending}
            className="focus-visible:ring-ring border-input min-h-11 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
          >
            {onCallUntil ? 'Extend' : 'Go on call'} for {hours}h
          </button>
        ))}
        {onCallUntil && (
          <button
            type="submit"
            name="hours"
            value="off"
            disabled={pending}
            className="focus-visible:ring-ring border-input min-h-11 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
          >
            Come off call
          </button>
        )}
      </form>

      <LiveRegion assertive>
        {state.error && (
          <p className="text-sm text-red-700 dark:text-red-400">{state.error}</p>
        )}
      </LiveRegion>
    </div>
  )
}
