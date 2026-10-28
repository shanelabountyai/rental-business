import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { completePlatformMfa } from '@/lib/platform/auth-actions.ts'

// Per request, so the CSP nonce exists (D-138; see app/login/mfa/page.tsx).
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Platform two-factor code' }

export default function PlatformMfaPage() {
  return (
    <AuthCard
      title="Enter your code"
      description="Open your authenticator app and enter the six-digit code. If you have lost your phone, enter one of your recovery codes instead."
    >
      <AuthForm action={completePlatformMfa} submitLabel="Verify">
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
