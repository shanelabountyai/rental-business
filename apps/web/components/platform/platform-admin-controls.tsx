'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField } from '@/components/form/field.tsx'
import { SetupLink } from '@/components/staff/setup-link.tsx'
import type { PlatformAdminFormState } from '@/lib/platform/admin-actions.ts'

export interface PlatformAssignmentRow {
  id: string
  roleName: string
  grantedLabel: string
  revokedLabel: string | null
  /// Why a revoke would be refused, worked out on the server before the press.
  revokeRefusal: string | null
}

/**
 * Every act on one platform admin, sharing ONE `useActionState` so the result
 * regions sit above every panel an act can change (the org's StaffControls,
 * for the same reason). A refusal the server already knows is shown as its
 * sentence in place of the button (§4.8); the action asks again on the press.
 */
export function PlatformAdminControls({
  action,
  adminId,
  adminName,
  assignments,
  roleOptions,
  refusals,
}: {
  action: (state: PlatformAdminFormState, formData: FormData) => Promise<PlatformAdminFormState>
  adminId: string
  adminName: string
  assignments: readonly PlatformAssignmentRow[]
  roleOptions: readonly { value: string; label: string }[]
  refusals: { grant: string | null; resetMfa: string | null; deactivate: string | null; resend: string | null }
}) {
  const [state, formAction] = useActionState<PlatformAdminFormState, FormData>(action, {})
  const live = assignments.filter((a) => a.revokedLabel === null)
  const history = assignments.filter((a) => a.revokedLabel !== null)
  const target = <input type="hidden" name="adminId" value={adminId} />

  return (
    <div className="flex flex-col gap-8">
      <FormAlerts state={state} />
      <SetupLink url={state.setupUrl} />

      <section aria-labelledby="roles" className="flex flex-col gap-3">
        <h2 id="roles" className="text-lg font-semibold">
          Platform roles
        </h2>
        {live.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No roles. {adminName} can sign in and will be refused everywhere.
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {live.map((row) => (
              <li key={row.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="flex min-w-0 flex-col break-words">
                  <span className="font-medium">{row.roleName}</span>
                  <span className="text-muted-foreground text-sm">Granted {row.grantedLabel}</span>
                </span>
                {row.revokeRefusal ? (
                  <p className="text-sm">{row.revokeRefusal}</p>
                ) : (
                  <form action={formAction}>
                    {target}
                    <input type="hidden" name="intent" value="revoke" />
                    <input type="hidden" name="assignmentId" value={row.id} />
                    <SubmitButton
                      label={
                        <>
                          Revoke<span className="sr-only"> {row.roleName}</span>
                        </>
                      }
                    />
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {refusals.grant ? (
          <p className="text-sm">{refusals.grant}</p>
        ) : (
          <form action={formAction} className="flex flex-col gap-4">
            {target}
            <input type="hidden" name="intent" value="grant" />
            <SelectField label="Role to grant" name="roleKey" required options={roleOptions} />
            <SubmitButton label="Grant role" />
          </form>
        )}
      </section>

      <section aria-labelledby="account" className="flex flex-col gap-4">
        <h2 id="account" className="text-lg font-semibold">
          Account
        </h2>
        <Act formAction={formAction} target={target} intent="resend" refusal={refusals.resend} label="Send a new setup link" />
        <Act formAction={formAction} target={target} intent="resetMfa" refusal={refusals.resetMfa} label="Reset two-factor" />
        <Act formAction={formAction} target={target} intent="deactivate" refusal={refusals.deactivate} label="Deactivate" />
      </section>

      {history.length > 0 && (
        <section aria-labelledby="history" className="flex flex-col gap-3">
          <h2 id="history" className="text-lg font-semibold">
            Revoked roles
          </h2>
          <ul className="text-muted-foreground flex flex-col gap-1 text-sm break-words">
            {history.map((row) => (
              <li key={row.id}>
                {row.roleName} · granted {row.grantedLabel}, revoked {row.revokedLabel}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function Act({
  formAction,
  target,
  intent,
  refusal,
  label,
}: {
  formAction: (formData: FormData) => void
  target: React.ReactNode
  intent: string
  refusal: string | null
  label: string
}) {
  if (refusal) {
    return (
      <p className="text-sm">
        <span className="font-medium">{label}:</span> {refusal}
      </p>
    )
  }
  return (
    <form action={formAction}>
      {target}
      <input type="hidden" name="intent" value={intent} />
      <SubmitButton label={label} />
    </form>
  )
}
