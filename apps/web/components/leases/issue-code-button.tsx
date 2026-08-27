'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton, useFocusWhen } from '@/components/auth-form.tsx'
import type { IssueCodeState } from '@/lib/leases/access-code-actions.ts'

/**
 * Hands a code to the tenant on click - privileged, MFA-gated, and gated
 * server-side on move-in funds having cleared (accesscode.issue, R-069).
 * Same "reveal into local render state only, never cached" posture as
 * `RevealCodeButton` - the code is never worth being cheaper to fetch the
 * second time.
 *
 * THE FORM REPLACES ITSELF WITH THE CODE, so `useFocusWhen` rather than a
 * live region (R-116, audit angle 25). The press destroys the button holding
 * focus, and the action returns `{ code }` with no notice, so a blind operator
 * heard silence, landed at the top of the document, and found the one-time
 * code unreachable. Focusing the revealed line announces the code AND the
 * sentence saying it is shown once - the whole new context.
 */
export function IssueCodeButton({
  codeLabel,
  action,
}: {
  /// Names WHICH code this row is - "Lockbox", "Gate". Every row on the panel
  /// renders one of these, so without it they all answer to "Issue to
  /// tenant" and pressing one hands out a stranger's key (R-116).
  codeLabel: string
  action: (state: IssueCodeState, formData: FormData) => Promise<IssueCodeState>
}) {
  const [state, formAction] = useActionState<IssueCodeState, FormData>(action, {})
  const revealed = useFocusWhen<HTMLSpanElement>(Boolean(state.code))

  if (state.code) {
    return (
      <span ref={revealed} tabIndex={-1} className="text-sm">
        {state.label ?? codeLabel} code{' '}
        <span className="bg-muted rounded-md px-2 py-1 font-mono">{state.code}</span> —
        shown once. Give it to them now.
      </span>
    )
  }

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <FormAlerts state={state} />
      <SubmitButton
        label={
          <>
            Issue to tenant<span className="sr-only"> — {codeLabel}</span>
          </>
        }
      />
    </form>
  )
}
