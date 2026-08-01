import { MIN_PASSWORD_LENGTH } from '@rental/core/auth'
import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { completePasswordReset } from '@/lib/auth/actions.ts'

export const metadata = { title: 'Choose a new password — Rental Operations' }

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  if (!token) {
    return (
      <AuthCard title="That link is incomplete">
        <p className="text-sm">
          Request a new reset link from the sign-in page.
        </p>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Choose a new password"
      description={`At least ${MIN_PASSWORD_LENGTH} characters. A memorable phrase beats a short password with symbols in it.`}
    >
      <AuthForm action={completePasswordReset} submitLabel="Save new password">
        {/*
          The token rides in a hidden field rather than being read from the URL
          in the action - server actions do not see the page's query string.
          It is single-use and already scoped to this user, so a hidden field
          costs nothing here (unlike a password, which is why the MFA step uses
          a cookie instead).
        */}
        <input type="hidden" name="token" value={token} />
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          autoFocus
        />
        <Field
          label="Confirm new password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
        />
      </AuthForm>
    </AuthCard>
  )
}
