import Link from 'next/link'
import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { requestPasswordReset } from '@/lib/auth/actions.ts'

export const metadata = { title: 'Reset your password — Rental Operations' }

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Reset your password"
      description="We will email a link that lets you set a new one."
      footer={
        <Link href="/login" className="underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      <AuthForm action={requestPasswordReset} submitLabel="Send reset link">
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoFocus
        />
      </AuthForm>
    </AuthCard>
  )
}
