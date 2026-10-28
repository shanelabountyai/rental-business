'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton, useFocusWhen } from '@/components/auth-form.tsx'
import type { FormState } from '@/components/auth-form.tsx'

type State = FormState & { recoveryCodes?: string[] }

// The account page's "Regenerate recovery codes" (PRD 11 §4.1, R-294c). The
// alerts stay mounted outside the branch that swaps in the codes, so an error
// is announced in place; the codes take focus, as MFA enrolment's do.
export function RecoveryCodesPanel({
  remaining,
  action,
}: {
  remaining: number
  action: (state: State) => Promise<State>
}) {
  const [state, formAction] = useActionState<State>(action, {})
  const codesRef = useFocusWhen<HTMLParagraphElement>(Boolean(state.recoveryCodes))

  return (
    <div className="flex flex-col gap-3">
      <FormAlerts state={{ error: state.error }} />
      {state.recoveryCodes ? (
        <>
          <p ref={codesRef} tabIndex={-1} className="text-sm font-medium">
            {state.notice} These will not be shown again.
          </p>
          <ul aria-label="New recovery codes" className="grid grid-cols-2 gap-2 font-mono text-sm">
            {state.recoveryCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="text-sm">
            {remaining} of 10 recovery codes left. Making new ones asks for a fresh code and
            cancels the old ones.
          </p>
          <form action={formAction}>
            <SubmitButton label="Regenerate recovery codes" />
          </form>
        </>
      )}
    </div>
  )
}
