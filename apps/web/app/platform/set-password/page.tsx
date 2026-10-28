import { MIN_PASSWORD_LENGTH } from '@rental/core/auth'
import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { setPlatformPassword } from '@/lib/platform/auth-actions.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Choose a password' }

export default async function PlatformSetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  if (!token) {
    return (
      <AuthCard title="That link is incomplete">
        <p className="text-sm">Open the whole link you were given, or ask for a new one.</p>
      </AuthCard>
    )
  }
  return (
    <AuthCard
      title="Choose a password"
      description={`At least ${MIN_PASSWORD_LENGTH} characters. You will set up two-factor authentication when you first sign in.`}
    >
      <AuthForm action={setPlatformPassword} submitLabel="Save password">
        <input type="hidden" name="token" value={token} />
        <Field label="New password" name="password" type="password" autoComplete="new-password" autoFocus />
        <Field label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" />
      </AuthForm>
    </AuthCard>
  )
}
