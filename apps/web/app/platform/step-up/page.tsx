import { stepUpReturnPath } from '@rental/core/auth'
import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { completePlatformStepUp } from '@/lib/platform/auth-actions.ts'
import { requirePlatform } from '@/lib/platform/guard.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Confirm it is you' }

// Step-up (PRD 11 §2.4, R-294c): a signed-in admin proves one more code before
// a sensitive act, then returns to the page that asked and presses again.
export default async function PlatformStepUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  await requirePlatform()
  const next = stepUpReturnPath((await searchParams).next, '/platform')
  return (
    <AuthCard
      title="Confirm it is you"
      description="That action needs a fresh code. Enter the six-digit code from your authenticator app, or a recovery code."
    >
      <AuthForm action={completePlatformStepUp} submitLabel="Confirm">
        <input type="hidden" name="next" value={next} />
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
