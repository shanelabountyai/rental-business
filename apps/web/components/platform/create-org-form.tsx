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

type OrgAction = (state: OrgInviteFormState, formData: FormData) => Promise<OrgInviteFormState>

/**
 * "Edit name / brand colours" (§4.6, R-304b). The preview is what
 * `brandStyle()` applies to the SAVED values: a colour that fails AA is
 * refused on save, so the swatches below are never a colour it would drop.
 */
export function OrgConfigurePanel({
  action,
  slug,
  name,
  colorPrimary,
  colorAccent,
  canConfigure,
}: {
  action: OrgAction
  slug: string
  name: string
  colorPrimary: string | null
  colorAccent: string | null
  canConfigure: boolean
}) {
  const [state, formAction] = useActionState<OrgInviteFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const swatch = (label: string, colour: string | null) => (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="inline-block size-5 rounded border"
        style={colour ? { backgroundColor: colour } : undefined}
      />
      {label}: {colour ?? 'default'}
    </span>
  )
  return (
    <section aria-labelledby="configure-heading" className="flex flex-col gap-3 rounded-md border p-4 text-sm">
      <h2 id="configure-heading" className="text-lg font-semibold">
        Name and brand colours
      </h2>
      <p className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
        {swatch('Primary', colorPrimary)}
        {swatch('Accent', colorAccent)}
      </p>
      <FormAlerts state={state} />
      {canConfigure && (
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="slug" value={slug} />
          <TextField label="Brand name" name="name" required defaultValue={name} error={errors.name} />
          <TextField
            label="Primary colour"
            name="colorPrimary"
            defaultValue={colorPrimary ?? ''}
            error={errors.colorPrimary}
            hint="Six-digit hex such as #1d4ed8, dark enough for white text. Blank uses the default."
          />
          <TextField
            label="Accent colour"
            name="colorAccent"
            defaultValue={colorAccent ?? ''}
            error={errors.colorAccent}
            hint="Also used for links on white. Blank uses the default."
          />
          <SubmitButton label="Save name and colours" />
        </form>
      )}
    </section>
  )
}

/** "Change slug" (§4.6, R-304b): the host moves, so the old slug is typed back. */
export function OrgSlugPanel({ action, slug, canConfigure }: { action: OrgAction; slug: string; canConfigure: boolean }) {
  const [state, formAction] = useActionState<OrgInviteFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  if (!canConfigure) return null
  return (
    <section aria-labelledby="slug-heading" className="flex flex-col gap-3 rounded-md border p-4 text-sm">
      <h2 id="slug-heading" className="text-lg font-semibold">
        Web address
      </h2>
      <p>
        Changing the slug moves the organisation to a new address. Staff signed in on the old address are signed out, and
        pending invitations must be resent. It asks for a fresh code.
      </p>
      <FormAlerts state={state} />
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="slug" value={slug} />
        <TextField label="New slug" name="newSlug" required error={errors.newSlug} />
        <TextField
          label="Type the current slug to confirm"
          name="confirmSlug"
          required
          error={errors.confirmSlug}
          hint={`The current slug is ${slug}.`}
        />
        <SubmitButton label="Change slug" />
      </form>
    </section>
  )
}

/**
 * "Notifications off / on" (PRD 11 §4.6, R-306). One form whose direction is
 * the org's current state, so a stale page cannot send the opposite of what
 * its button said: the action refuses a switch to the value already set.
 */
export function OrgNotificationsPanel({
  action,
  slug,
  enabled,
  canConfigure,
}: {
  action: OrgAction
  slug: string
  enabled: boolean
  canConfigure: boolean
}) {
  const [state, formAction] = useActionState<OrgInviteFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  if (!canConfigure) return null
  return (
    <section aria-labelledby="notifications-heading" className="flex flex-col gap-3 rounded-md border p-4 text-sm">
      <h2 id="notifications-heading" className="text-lg font-semibold">
        Notifications
      </h2>
      {enabled ? (
        <p>
          On. Switching them off stops every email and text for this organisation at once. Anything already queued is
          held and goes out when they are switched back on; anything created while they are off is recorded as not sent
          and never goes. It asks for a fresh code.
        </p>
      ) : (
        <p>
          Switched off. Switching them on sends anything held in the queue on the next drain; the queued count is under
          Health below. If the queue is what went wrong, have it cleared before switching on. It asks for a fresh code.
        </p>
      )}
      <FormAlerts state={state} />
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="intent" value={enabled ? 'off' : 'on'} />
        <TextField
          label={enabled ? 'Reason for switching notifications off' : 'Reason for switching notifications on'}
          name="reason"
          required
          error={errors.reason}
          hint="Recorded in the organisation's audit log."
        />
        <SubmitButton label={enabled ? 'Switch notifications off' : 'Switch notifications on'} />
      </form>
    </section>
  )
}
