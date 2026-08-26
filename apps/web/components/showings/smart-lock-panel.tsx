'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { AccessAdminState } from '@/lib/showings/staff-actions.ts'

// The smart lock on a unit (LEASE-08, PROP-03; R-094).
//
// THE KILL IS THE PROMINENT CONTROL, deliberately. Everything else on this
// panel is a record of what happened; this is the one thing somebody needs
// while it is happening, and it needs to be reachable on a phone without
// hunting.

type Action = (state: AccessAdminState, formData: FormData) => Promise<AccessAdminState>

export interface AccessRow {
  showingId: string
  /// BOUND SERVER-SIDE, one per row. A `(showingId) => action.bind(...)`
  /// prop would be a plain function crossing the Server→Client boundary,
  /// which has no identity the client can call back to - and `npm run build`
  /// does not catch it, the page just 500s in the browser (CLAUDE.md).
  revokeAction: Action
  prospectName: string
  when: string
  window: string
  live: boolean
  revoked: {
    at: string
    reason: string
    by: string | null
    /// Null on a row pulled before this was recorded - "not known", which is
    /// not the same as "the door is fine".
    reachedDevice: boolean | null
  } | null
  identity: string
}

export interface EventRow {
  id: string
  kind: string
  when: string
  actorLabel: string
  who: string | null
}

export function SmartLockPanel({
  label,
  accesses,
  events,
  canRevoke,
  syncAction,
}: {
  label: string
  accesses: readonly AccessRow[]
  events: readonly EventRow[]
  canRevoke: boolean
  syncAction: () => Promise<AccessAdminState>
}) {
  const [syncState, sync] = useActionState<AccessAdminState, FormData>(async () => syncAction(), {})

  return (
    <section aria-labelledby="smart-lock" className="flex flex-col gap-4 rounded-md border p-4">
      <div className="flex flex-col gap-1">
        <h2 id="smart-lock" className="text-sm font-semibold">
          Smart lock and self-showings
        </h2>
        <p className="text-muted-foreground text-sm">{label}</p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-3">
        <h3 className="text-sm font-medium">Entry codes issued to viewers</h3>
        {accesses.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No self-showing code has been issued for this unit.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {accesses.map((access) => (
              <li key={access.showingId} className="flex flex-col gap-2 rounded-md border p-3">
                <p className="text-sm">
                  <span className="font-medium">{access.prospectName}</span> — {access.when}
                </p>
                <p className="text-muted-foreground text-sm">
                  Code live {access.window}. ID: {access.identity}.
                </p>
                {access.revoked ? (
                  <>
                    <p className="text-sm">
                      Pulled {access.revoked.at}
                      {access.revoked.by ? ` by ${access.revoked.by}` : ''} —{' '}
                      {access.revoked.reason}
                    </p>
                    {/* The one message here that asks for a trip to the
                        property, so it survives the re-render rather than
                        living in a toast. */}
                    {access.revoked.reachedDevice === false && (
                      <p className="rounded-md border border-red-300 p-2 text-sm font-medium text-red-800">
                        The lock did not answer when this was pulled. Treat the code as still
                        working until somebody has confirmed it at the device or changed the
                        lock.
                      </p>
                    )}
                    {access.revoked.reachedDevice == null && (
                      <p className="text-muted-foreground text-sm">
                        Whether the lock accepted this was not recorded.
                      </p>
                    )}
                  </>
                ) : (
                  canRevoke && <RevokeForm action={access.revokeAction} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t pt-3">
        <h3 className="text-sm font-medium">What the lock says happened</h3>
        <FormAlerts state={syncState} />
        {events.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing has been read back from this lock yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {events.map((event) => (
              <li key={event.id}>
                <span className="font-mono">{event.when}</span> — {event.kind.toLowerCase()} ·{' '}
                {/* An entry no code of ours explains is the one worth
                    looking at, so it says so rather than showing a blank. */}
                {event.who ?? `${event.actorLabel} (no code of ours)`}
              </li>
            ))}
          </ul>
        )}
        <form action={sync}>
          <SubmitButton label="Read the lock’s log" />
        </form>
      </div>
    </section>
  )
}

function RevokeForm({ action }: { action: Action }) {
  const [state, submit] = useActionState<AccessAdminState, FormData>(action, {})
  return (
    <form action={submit} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <TextField
        label="Why the code is being pulled"
        name="reason"
        required
        idPrefix="revoke-access"
        error={state.fieldErrors?.reason}
        hint="Recorded against the viewing. Somebody standing at a locked door will ask."
      />
      <SubmitButton label="Pull this entry code now" />
    </form>
  )
}
