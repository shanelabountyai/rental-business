'use client'

import type { ReactNode } from 'react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { FormAlerts, SubmitButton, pendingButtonProps } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { StaffFormState } from '@/lib/staff/actions.ts'
import { SetupLink } from './setup-link.tsx'

export interface AssignmentRow {
  id: string
  roleName: string
  scopeLabel: string
  grantedLabel: string
  revokedLabel: string | null
  grantedByName: string | null
}

/**
 * Every mutation on one staff member, sharing ONE `useActionState`.
 *
 * That is the whole reason this is a single component rather than four. Each
 * control changes whether its own panel renders - the last revoke empties the
 * list, deactivating swaps the button - and a result region inside a panel the
 * action unmounts announces nothing at all. Several `<form>`s can share one
 * dispatch function, so the regions live here, above all of them, mounted
 * whatever the state.
 */
export function StaffControls({
  action,
  staffName,
  active,
  assignments,
  roleOptions,
  scopeOptions,
  approveWorkOrderDollars,
  waiveFeeDollars,
}: {
  action: (state: StaffFormState, formData: FormData) => Promise<StaffFormState>
  staffName: string
  active: boolean
  assignments: readonly AssignmentRow[]
  roleOptions: readonly { value: string; label: string }[]
  scopeOptions: readonly { value: string; label: string }[]
  approveWorkOrderDollars: string
  waiveFeeDollars: string
}) {
  const [state, formAction] = useActionState<StaffFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const live = assignments.filter((a) => a.revokedLabel === null)
  const revoked = assignments.filter((a) => a.revokedLabel !== null)

  return (
    <div className="flex flex-col gap-8">
      <FormAlerts state={state} />
      <SetupLink url={state.setupUrl} />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Current access</h2>
        {live.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No active assignments. {staffName} can sign in and will be refused everywhere.
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {live.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="flex flex-col">
                  <span className="font-medium">{row.roleName}</span>
                  <span className="text-muted-foreground text-sm">
                    {row.scopeLabel} · granted {row.grantedLabel}
                    {row.grantedByName ? ` by ${row.grantedByName}` : ''}
                  </span>
                </span>
                {/* Each button's accessible name carries the role and scope.
                    A page of identically-named "Revoke" buttons is ambiguous
                    for anyone navigating by label, and Playwright's strict
                    mode catches it as a confusing failure rather than as
                    what it is. */}
                <form action={formAction}>
                  <input type="hidden" name="intent" value="revoke" />
                  <input type="hidden" name="assignmentId" value={row.id} />
                  <RevokeButton roleName={row.roleName} scopeLabel={row.scopeLabel} />
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Grant access</h2>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="intent" value="grant" />
          <SelectField
            label="Role"
            name="roleKey"
            required
            options={roleOptions}
            error={errors.roleKey}
          />
          <SelectField
            label="Access scope"
            name="scope"
            required
            defaultValue="all"
            options={scopeOptions}
            error={errors.scope}
          />
          <SubmitButton label="Grant access" />
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Approval ceilings</h2>
        <p className="text-muted-foreground text-sm">
          Leave blank to use the role&rsquo;s default. Zero is a real value meaning they may
          approve nothing (ROLE-02).
        </p>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="intent" value="ceilings" />
          <TextField
            label="Work order approval ceiling (dollars)"
            name="approveWorkOrderDollars"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            defaultValue={approveWorkOrderDollars}
          />
          <TextField
            label="Fee waiver ceiling (dollars)"
            name="waiveFeeDollars"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            defaultValue={waiveFeeDollars}
          />
          <SubmitButton label="Save ceilings" />
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Account</h2>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="intent" value="resend" />
          <SubmitButton label="Send a new password setup link" />
        </form>

        {active ? (
          <form action={formAction} className="flex flex-col gap-4">
            <input type="hidden" name="intent" value="deactivate" />
            <TextField
              label="Why they are leaving (optional)"
              name="reason"
              hint="Recorded on the audit entry."
            />
            <DangerButton
              label={
                <>
                  Deactivate<span className="sr-only"> {staffName}</span>
                </>
              }
            />
          </form>
        ) : (
          <form action={formAction}>
            <input type="hidden" name="intent" value="reactivate" />
            <SubmitButton
              label={
                <>
                  Reactivate<span className="sr-only"> {staffName}</span>
                </>
              }
            />
          </form>
        )}
      </section>

      {revoked.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Revoked access</h2>
          <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
            {revoked.map((row) => (
              <li key={row.id}>
                {row.roleName} · {row.scopeLabel} · granted {row.grantedLabel}, revoked{' '}
                {row.revokedLabel}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/// `useFormStatus` reads the nearest enclosing form, so these have to be
/// components rather than markup inlined above.
function RevokeButton({ roleName, scopeLabel }: { roleName: string; scopeLabel: string }) {
  return (
    <button
      type="submit"
      {...pendingButtonProps(useFormStatus().pending)}
      className="focus-visible:ring-ring min-h-11 rounded-md border px-3 text-sm font-medium aria-disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      Revoke
      <span className="sr-only">
        {' '}
        {roleName} on {scopeLabel}
      </span>
    </button>
  )
}

function DangerButton({ label }: { label: ReactNode }) {
  return (
    <button
      type="submit"
      {...pendingButtonProps(useFormStatus().pending)}
      className="focus-visible:ring-ring min-h-11 w-fit rounded-md border border-red-300 bg-red-50 px-4 text-sm font-medium text-red-900 aria-disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {label}
    </button>
  )
}

