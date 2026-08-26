'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { TenantLockCodeState } from '@/lib/leases/access-code-actions.ts'

// One door code per person on the tenancy (PROP-03, LEASE-08; R-094b).
//
// LABELS ARE CHECKED AGAINST THE WHOLE ASSEMBLED PAGE, not just this panel -
// `/leases/[id]` now carries a dozen of them and four collisions have landed
// in three consecutive items. "Door code" is the qualifier that keeps every
// control here distinct from the unit page's own "Code"/"Save code" and from
// R-094's "Why the code is being pulled".

type Action = (state: TenantLockCodeState, formData: FormData) => Promise<TenantLockCodeState>

export interface DoorCodeRow {
  tenantId: string
  name: string
  /// Null where they hold no live code.
  live: {
    issuedOn: string
    issuedBy: string
  } | null
  /// The last revoke, where the device did not agree. Rendered in red for as
  /// long as it is true, because it is the one thing here that asks somebody
  /// to drive to the property.
  strandedAt: string | null
  issueAction: () => Promise<TenantLockCodeState>
  revokeAction: Action
}

export function DoorCodesPanel({
  hasSmartLock,
  rows,
  canIssue,
  canRevoke,
}: {
  hasSmartLock: boolean
  rows: readonly DoorCodeRow[]
  canIssue: boolean
  canRevoke: boolean
}) {
  return (
    <section aria-labelledby="door-codes" className="flex flex-col gap-4 rounded-md border p-4">
      <div className="flex flex-col gap-1">
        <h2 id="door-codes" className="text-sm font-semibold">
          Door codes
        </h2>
        {hasSmartLock ? (
          <p className="text-muted-foreground text-sm">
            One code each, programmed into the lock. They stop working on their own when the
            tenancy ends or when somebody comes off the lease — nobody has to remember.
          </p>
        ) : (
          // Said plainly rather than hiding the panel: an operator who cannot
          // see why the feature is missing assumes it is broken.
          <p className="text-muted-foreground text-sm">
            This unit has no smart lock on file, so this system cannot program a door. Keys and
            lockbox codes are handed over from the unit&rsquo;s own access codes, and handing one
            over changes no lock.
          </p>
        )}
      </div>

      {hasSmartLock &&
        rows.map((row) => (
          <div key={row.tenantId} className="flex flex-col gap-2 border-t pt-3">
            <p className="text-sm font-medium">{row.name}</p>
            {row.strandedAt && (
              <p className="rounded-md border border-red-300 p-2 text-sm font-medium text-red-800">
                Their code was revoked on {row.strandedAt} but the lock did not answer. Treat it
                as still working until somebody has confirmed it at the device or changed the
                lock.
              </p>
            )}
            {row.live ? (
              <>
                <p className="text-muted-foreground text-sm">
                  Holds a code, given {row.live.issuedOn} by {row.live.issuedBy}.
                </p>
                {canRevoke && <RevokeForm action={row.revokeAction} />}
              </>
            ) : (
              canIssue && <IssueForm name={row.name} action={row.issueAction} />
            )}
          </div>
        ))}
    </section>
  )
}

function IssueForm({ name, action }: { name: string; action: () => Promise<TenantLockCodeState> }) {
  const [state, submit] = useActionState<TenantLockCodeState, FormData>(async () => action(), {})
  return (
    <form action={submit} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      {/* The code lives in this component's own local state and nowhere
          else - the action deliberately does not revalidate, or this form
          would be unmounted by its own response before the code was read.
          R-069's static path documents the same trap. */}
      {state.code && (
        <div className="flex flex-col gap-1 rounded-md border p-3">
          <p className="text-sm font-medium">{name}&rsquo;s door code</p>
          <p className="font-mono text-3xl tracking-[0.3em]">{state.code}</p>
          <p className="text-muted-foreground text-sm">
            Shown once. Give it to them now — reading it back later is a separate, logged act.
          </p>
        </div>
      )}
      {!state.code && <SubmitButton label="Give them a door code" />}
    </form>
  )
}

function RevokeForm({ action }: { action: Action }) {
  const [state, submit] = useActionState<TenantLockCodeState, FormData>(action, {})
  return (
    <form action={submit} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <TextField
        label="Why this door code is being revoked"
        name="reason"
        required
        idPrefix="door-code"
        error={state.fieldErrors?.reason}
        hint="Recorded on the tenancy. A code that stopped working for no recorded reason is the one somebody rings about at 9pm."
      />
      <SubmitButton label="Revoke this door code" />
    </form>
  )
}
