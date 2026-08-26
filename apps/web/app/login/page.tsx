import Link from 'next/link'
import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { startStaffSignIn } from '@/lib/auth/actions.ts'

export const metadata = { title: 'Sign in — Rental Operations' }

export default async function StaffLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>
}) {
  const { reset } = await searchParams

  return (
    <AuthCard
      title="Sign in"
      description="Staff access to the rental operations platform."
      footer={
        <Link href="/forgot-password" className="underline underline-offset-4">
          Forgot your password?
        </Link>
      }
    >
      {reset && (
        <p
          role="status"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          Your password was changed. Sign in with the new one.
        </p>
      )}
      <AuthForm action={startStaffSignIn} submitLabel="Sign in">
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoFocus
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
        />
      </AuthForm>
    </AuthCard>
  )
}
