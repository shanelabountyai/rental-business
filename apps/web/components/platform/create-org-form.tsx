'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import { SetupLink } from '@/components/staff/setup-link.tsx'
import type { OrgInviteFormState } from '@/lib/platform/org-actions.ts'

// `/platform/orgs/new` (PRD 11 §4.5, R-304a): the organisation and its owner's
// invitation in one press.
export function CreateOrgForm({
  action,
}: {
  action: (state: OrgInviteFormState, formData: FormData) => Promise<OrgInviteFormState>
}) {
  const [state, formAction] = useActionState<OrgInviteFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />
      <SetupLink url={state.setupUrl} />
      <TextField label="Organisation name" name="name" required error={errors.name} />
      <TextField
        label="Slug (its web address)"
        name="slug"
        required
        error={errors.slug}
        hint="Lower-case letters, digits and hyphens. It becomes the organisation's own web address."
      />
      <TextField label="Owner's full name" name="ownerName" required error={errors.ownerName} />
      <TextField label="Owner's email address" name="ownerEmail" type="email" required error={errors.ownerEmail} />
      <SubmitButton label="Create and invite the owner" />
    </form>
  )
}

export interface PendingInviteRow {
  id: string
  email: string
  name: string
  /// "expires 5 Nov 2026" or "expired 5 Nov 2026", worked out on the server.
  expiryLabel: string
}

/**
 * The org page's pending invites (§4.4), "Resend" and "Revoke" sharing ONE
 * `useActionState` so the result region sits above the list they change.
 */
export function OrgInvitesPanel({
  action,
  slug,
  invites,
  canManage,
}: {
  action: (state: OrgInviteFormState, formData: FormData) => Promise<OrgInviteFormState>
  slug: string
  invites: readonly PendingInviteRow[]
  canManage: boolean
}) {
  const [state, formAction] = useActionState<OrgInviteFormState, FormData>(action, {})
  const button = (invite: PendingInviteRow, intent: 'resend' | 'revoke', label: string) => (
    <form action={formAction}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="inviteId" value={invite.id} />
      <input type="hidden" name="intent" value={intent} />
      <SubmitButton
        label={
          <>
            {label}
            <span className="sr-only"> the invitation to {invite.email}</span>
          </>
        }
      />
    </form>
  )

  return (
    <section aria-labelledby="invites-heading" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
      <h2 id="invites-heading" className="text-lg font-semibold">
        Pending invitations
      </h2>
      <FormAlerts state={state} />
      <SetupLink url={state.setupUrl} />
      {invites.length === 0 ? (
        <p>No pending invitations.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {invites.map((invite) => (
            <li key={invite.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex min-w-0 flex-col break-words">
                <span className="font-medium">
                  {invite.name} · {invite.email}
                </span>
                <span className="text-muted-foreground">Owner · {invite.expiryLabel}</span>
              </span>
              {canManage && (
                <span className="flex gap-2">
                  {button(invite, 'resend', 'Resend')}
                  {button(invite, 'revoke', 'Revoke')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
