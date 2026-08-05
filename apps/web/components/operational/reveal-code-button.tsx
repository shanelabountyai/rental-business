'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { RevealState } from '@/lib/operational/actions.ts'

/**
 * Reveals one access-code version on click - privileged and MFA-gated
 * server-side (accesscode.reveal), logged every time regardless of whether
 * this button is shown once or clicked fifty times (PROP-03: "each reveal
 * is logged", not "the first reveal is logged").
 *
 * The decrypted code lives only in this component's own render state - never
 * written back to the URL, never cached, gone the moment the page is left or
 * reloaded. Revealing again means asking the server again, which is the
 * point: nothing about a lockbox code should be cheaper to retrieve the
 * second time than the first.
 */
export function RevealCodeButton({
  action,
}: {
  action: (state: RevealState, formData: FormData) => Promise<RevealState>
}) {
  const [state, formAction] = useActionState<RevealState, FormData>(action, {})

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
      <SubmitButton label="Reveal" />
    </form>
  )
}
