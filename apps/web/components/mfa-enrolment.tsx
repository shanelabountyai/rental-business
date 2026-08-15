'use client'

import { useActionState, useState } from 'react'
import { useFocusWhen } from '@/components/auth-form.tsx'
import { Field, FormAlerts, SubmitButton } from './auth-form.tsx'
import type { FormState } from './auth-form.tsx'

interface EnrolmentState extends FormState {
  secret?: string
  uri?: string
}
interface ConfirmState extends FormState {
  recoveryCodes?: string[]
}

export function MfaEnrolment({
  enrolled,
  begin,
  confirm,
}: {
  enrolled: boolean
  begin: () => Promise<EnrolmentState>
  confirm: (state: ConfirmState, formData: FormData) => Promise<ConfirmState>
}) {
  const [setup, setSetup] = useState<EnrolmentState | null>(null)
  const [confirmState, confirmAction] = useActionState<ConfirmState, FormData>(
    confirm,
    {},
  )

  // `confirmState` only ever holds codes after the action ran in THIS
  // session - they are shown exactly once and never re-fetched - so unlike
  // the other two panels there is no page-load case to guard against
  // (R-101d).
  const codesRef = useFocusWhen<HTMLParagraphElement>(Boolean(confirmState.recoveryCodes))

  if (enrolled && !confirmState.recoveryCodes) {
    return (
      <p className="text-sm">
        Two-factor authentication is <strong>on</strong> for this account.
      </p>
    )
  }

  if (confirmState.recoveryCodes) {
    return (
      <div className="flex flex-col gap-3">
        {/* Focused rather than announced through a live region: this whole
            branch REPLACES the enrolment form, so the region would be a new
            node with no change to report, and the button that had focus has
            just been unmounted. Focus here announces the confirmation and
            leaves the reader at the top of the codes they must save now
            (R-101d). No heading is added - this sentence already is one in
            everything but markup, and restructuring the UI for a screen that
            is shown exactly once is more change than the fix needs. */}
        <p ref={codesRef} tabIndex={-1} className="text-sm font-medium">
          {confirmState.notice}
        </p>
        {/*
          Shown exactly once. Only hashes were stored, so there is no "show
          them again" - which is the property that makes a stolen database
          useless, and the reason this warning is not softened.
        */}
        <p className="text-sm">
          These will not be shown again. Each one works once, if you lose your
          phone.
        </p>
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
          {confirmState.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </div>
    )
  }

  if (!setup?.secret) {
    return (
      <form
        action={async () => {
          setSetup(await begin())
        }}
      >
        <button
          type="submit"
          className="bg-primary text-primary-foreground focus-visible:ring-ring min-h-11 rounded-md px-4 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Set up two-factor authentication
        </button>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-sm">
          Add this key to your authenticator app, then enter the code it shows.
        </p>
        {/*
          The setup key as selectable text rather than a QR image. A QR needs a
          rendering dependency for what is, at this stage, one screen used by
          three people - and every authenticator app supports manual entry.
          R-007 can add the QR when it brings in the admin shell.
        */}
        <code className="bg-muted rounded-md px-3 py-2 font-mono text-sm break-all select-all">
          {setup.secret}
        </code>
      </div>

      {/*
        Composed from the same pieces AuthForm uses rather than nesting it:
        useActionState already lives in this component, because the recovery
        codes returned by the action have to survive into the next render.
      */}
      <form action={confirmAction} className="flex flex-col gap-5">
        <FormAlerts state={confirmState} />
        <Field
          label="Code from your authenticator app"
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          autoFocus
        />
        <SubmitButton label="Turn on two-factor" />
      </form>
    </div>
  )
}
