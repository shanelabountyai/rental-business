'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { SupportSessionFormState } from '@/lib/support/session-actions.ts'

type Action = (state: SupportSessionFormState, formData: FormData) => Promise<SupportSessionFormState>

/**
 * PRD 11 §4.7: above the header on every page of a support session. An
 * `<aside>`, never `role="alert"` - Next's route announcer already is one
 * (CLAUDE.md). It wraps at 375px rather than truncating, so the end time is
 * always readable. The result region sits outside the form the press removes.
 */
export function SupportSessionBanner({ action, orgName, endsLabel }: { action: Action; orgName: string; endsLabel: string }) {
  const [state, formAction] = useActionState(action, {})
  return (
    <aside
      aria-label="Support session"
      className="flex flex-col gap-3 border-b border-warning/35 bg-warning/6 px-4 py-3 text-sm break-words sm:flex-row sm:items-center sm:justify-between"
    >
      <p>
        You are viewing <strong>{orgName}</strong> as platform support · read-only · ends at {endsLabel}
      </p>
      <FormAlerts state={state} />
      {state.notice ? (
        <Link href="/support/ended" className="underline underline-offset-4">
          Continue
        </Link>
      ) : (
        <form action={formAction}>
          <SubmitButton label="End now" />
        </form>
      )}
    </aside>
  )
}

/// `/support/ended`'s one press: drop this browser's support cookie.
export function LeaveSupportSessionForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, {})
  return (
    <div className="flex flex-col gap-3">
      <FormAlerts state={state} />
      {!state.notice && (
        <form action={formAction}>
          <SubmitButton label="Leave the support session" />
        </form>
      )}
    </div>
  )
}
