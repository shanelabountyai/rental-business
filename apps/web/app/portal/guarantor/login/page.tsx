import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { requestGuarantorMagicLink } from '@/lib/auth/actions.ts'

// Rendered per request, same reason as /portal/login: a prerendered page has
// no CSP nonce to stamp on its scripts (D-138).
export const dynamic = 'force-dynamic'

export const metadata = { title: 'Sign in — Rental Operations' }

// A guarantor is not a tenant (LEASE-06) and D-10's tenant lexicon does not
// apply to them - they never lived there, so "your home" would be wrong on
// this page specifically. "What you guarantee" is the honest description of
// why they have an account at all.
const LINK_ERRORS: Record<string, string> = {
  invalid:
    'That sign-in link has stopped working. Links only work once and they expire after a while - and some email apps open them before you do. Enter your email below and we will send a fresh one.',
  missing:
    'That sign-in link was incomplete - some email apps cut long links in half. Enter your email below and we will send a fresh one.',
}

export default async function GuarantorLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const message = error ? (LINK_ERRORS[error] ?? LINK_ERRORS.invalid) : null

  return (
    <AuthCard
      title="Sign in"
      description="Enter the email address on file for your guarantee and we will send you a sign-in link. There is no password to remember."
    >
      {message && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {message}
        </p>
      )}
      <AuthForm action={requestGuarantorMagicLink} submitLabel="Email me a link">
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoFocus={!message}
        />
      </AuthForm>
    </AuthCard>
  )
}
