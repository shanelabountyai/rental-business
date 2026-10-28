import { AuthCard, AuthForm, Field, FocusedStatus } from '@/components/auth-form.tsx'
import { startPlatformSignIn } from '@/lib/platform/auth-actions.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Platform sign-in' }

export default async function PlatformLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ set?: string }>
}) {
  const { set } = await searchParams
  return (
    <AuthCard title="Platform sign-in" description="Administration of the platform itself. Organisation staff sign in on their own address.">
      {set && (
        <FocusedStatus className="rounded-md border border-success/35 bg-success/6 px-3 py-2 text-sm text-success">
          Your password is set. Sign in with it.
        </FocusedStatus>
      )}
      <AuthForm action={startPlatformSignIn} submitLabel="Sign in">
        <Field label="Email" name="email" type="email" autoComplete="username" inputMode="email" autoFocus />
        <Field label="Password" name="password" type="password" autoComplete="current-password" />
      </AuthForm>
    </AuthCard>
  )
}
