import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { completeStaffMfa } from '@/lib/auth/actions.ts'

export const metadata = { title: 'Two-factor code — Rental Operations' }

export default function MfaChallengePage() {
  return (
    <AuthCard
      title="Enter your code"
      description="Open your authenticator app and enter the six-digit code. If you have lost your phone, enter one of your recovery codes instead."
    >
      <AuthForm action={completeStaffMfa} submitLabel="Verify">
        {/*
          Not type="number": a spinner on a one-time code is useless, and
          leading zeros get eaten. inputMode brings up the numeric keypad on a
          phone without any of that.
        */}
        <Field
          label="Six-digit code or recovery code"
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          autoFocus
        />
      </AuthForm>
    </AuthCard>
  )
}
