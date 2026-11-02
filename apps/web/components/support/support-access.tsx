'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { SupportAccessFormState } from '@/lib/support/actions.ts'

// `/settings/support-access` and the dashboard's break-glass banner (PRD 11
// §4.14, §4.16, R-295a). Each control names the admin it answers, so two
// requests never share an accessible name (CLAUDE.md). One result region per
// component, mounted outside every card, because a press removes its card.

type Action = (state: SupportAccessFormState, formData: FormData) => Promise<SupportAccessFormState>

export interface PendingRequestView {
  id: string
  adminName: string
  reason: string
  requestedLabel: string
  durationLabel: string
  approvable: { value: string; label: string }[]
}

export interface LiveGrantView {
  id: string
  adminName: string
  kindLabel: string
  endsLabel: string
}

export interface GrantHistoryView {
  id: string
  adminName: string
  kindLabel: string
  statusLabel: string
  reason: string
  requestedLabel: string
  detail: string | null
}

export function SupportAccessPanel({
  action,
  canManage,
  pending,
  live,
  history,
}: {
  action: Action
  canManage: boolean
  pending: PendingRequestView[]
  live: LiveGrantView[]
  history: GrantHistoryView[]
}) {
  const [state, formAction] = useActionState<SupportAccessFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const never = pending.length + live.length + history.length === 0

  return (
    <div className="flex flex-col gap-6">
      <FormAlerts state={state} />
      {never && <p className="text-sm">Platform support has never asked to view your organisation.</p>}

      {pending.length > 0 && (
        <section aria-labelledby="pending-heading" className="flex flex-col gap-3">
          <h2 id="pending-heading" className="text-lg font-semibold">
            Waiting for an answer
          </h2>
          <ul className="flex flex-col gap-3">
            {pending.map((p) => (
              <li key={p.id} className="flex flex-col gap-3 rounded-lg border border-border p-4 text-sm break-words">
                <p className="font-medium">
                  {p.adminName} asks for {p.durationLabel} of read-only access
                </p>
                <p>Reason: {p.reason}</p>
                <p className="text-muted-foreground">Asked {p.requestedLabel}</p>
                {canManage && (
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    <form action={formAction} className="flex min-w-0 flex-1 flex-col gap-3">
                      <input type="hidden" name="intent" value="approve" />
                      <input type="hidden" name="grantId" value={p.id} />
                      <SelectField
                        label={`Duration for ${p.adminName}`}
                        name="minutes"
                        required
                        defaultValue={p.approvable.at(-1)?.value}
                        options={p.approvable}
                        idPrefix={`approve-${p.id}`}
                      />
                      <TextField
                        label={`Your authenticator code to approve ${p.adminName}`}
                        name="code"
                        required
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        error={errors.code}
                        idPrefix={`approve-${p.id}`}
                      />
                      <SubmitButton label={`Approve request from ${p.adminName}`} />
                    </form>
                    <form action={formAction} className="flex min-w-0 flex-1 flex-col gap-3">
                      <input type="hidden" name="intent" value="deny" />
                      <input type="hidden" name="grantId" value={p.id} />
                      <TextField label={`Note to ${p.adminName} (optional)`} name="note" idPrefix={`deny-${p.id}`} />
                      <SubmitButton label={`Deny request from ${p.adminName}`} />
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {live.length > 0 && (
        <section aria-labelledby="live-heading" className="flex flex-col gap-3">
          <h2 id="live-heading" className="text-lg font-semibold">
            Open now
          </h2>
          <ul className="flex flex-col gap-3">
            {live.map((g) => (
              <li key={g.id} className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm break-words">
                <p className="font-medium">
                  {g.adminName} · {g.kindLabel} · ends {g.endsLabel}
                </p>
                {canManage && (
                  <form action={formAction}>
                    <input type="hidden" name="intent" value="revoke" />
                    <input type="hidden" name="grantId" value={g.id} />
                    <SubmitButton label={`Revoke access for ${g.adminName} now`} />
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {history.length > 0 && (
        <section aria-labelledby="history-heading" className="flex flex-col gap-3">
          <h2 id="history-heading" className="text-lg font-semibold">
            History
          </h2>
          <ul className="flex flex-col gap-3">
            {history.map((g) => (
              <li key={g.id} className="flex flex-col gap-1 rounded-lg border border-border p-4 text-sm break-words">
                <p className="font-medium">
                  {g.adminName} · {g.kindLabel} · {g.statusLabel}
                </p>
                <p>Reason: {g.reason}</p>
                <p className="text-muted-foreground">Asked {g.requestedLabel}</p>
                {g.detail && <p>{g.detail}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export interface BreakGlassNotice {
  id: string
  adminName: string
  dateLabel: string
}

/**
 * §4.16: on the dashboard until one owner presses "Seen". An `<aside>`, never
 * `role="alert"`: Next's route announcer already is one (CLAUDE.md). Always
 * mounted by the page, so "Seen" can say so after its own notice is gone.
 */
export function BreakGlassBanners({
  action,
  notices,
  canAcknowledge,
}: {
  action: Action
  notices: BreakGlassNotice[]
  canAcknowledge: boolean
}) {
  const [state, formAction] = useActionState<SupportAccessFormState, FormData>(action, {})
  return (
    <div className="flex flex-col gap-3">
      <FormAlerts state={state} />
      {notices.map((n) => (
        <aside
          key={n.id}
          aria-label={`Emergency access by ${n.adminName} on ${n.dateLabel}`}
          className="flex flex-col gap-3 rounded-lg border border-danger/35 bg-danger/6 p-4 text-sm break-words sm:flex-row sm:items-center sm:justify-between"
        >
          <p>
            Platform support ({n.adminName}) used emergency access on {n.dateLabel}.{' '}
            {/* "See what was viewed" is R-295b's /settings/audit?grant=; until then the grant itself. */}
            <Link href="/settings/support-access" className="underline underline-offset-4">
              See the grant
            </Link>
          </p>
          {canAcknowledge && (
            <form action={formAction}>
              <input type="hidden" name="intent" value="seen" />
              <input type="hidden" name="grantId" value={n.id} />
              <SubmitButton label={`Mark emergency access by ${n.adminName} as seen`} />
            </form>
          )}
        </aside>
      ))}
    </div>
  )
}
