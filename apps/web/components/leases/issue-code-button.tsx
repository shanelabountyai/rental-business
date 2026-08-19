'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { IssueCodeState } from '@/lib/leases/access-code-actions.ts'

/**
 * Hands a code to the tenant on click - privileged, MFA-gated, and gated
 * server-side on move-in funds having cleared (accesscode.issue, R-069).
 * Same "reveal into local render state only, never cached" posture as
 * `RevealCodeButton` - the code is never worth being cheaper to fetch the
 * second time.
 */
export function IssueCodeButton({
  action,
}: {
  action: (state: IssueCodeState, formData: FormData) => Promise<IssueCodeState>
}) {
  const [state, formAction] = useActionState<IssueCodeState, FormData>(action, {})

  if (state.code) {
    return (
      <span className="rounded-md bg-muted px-2 py-1 font-mono text-sm">
        {state.code}
      </span>
    )
  }

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <FormAlerts state={state} />
      <SubmitButton label="Issue to tenant" />
    </form>
  )
}
