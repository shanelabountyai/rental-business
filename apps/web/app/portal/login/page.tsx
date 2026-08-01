import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { requestTenantMagicLink } from '@/lib/auth/actions.ts'

export const metadata = { title: 'Sign in to your home — Rental Operations' }

// Tenant-facing, so D-10's lexicon applies: "home", "rent", "maintenance
// request". No internal identifier, no entity name, no status enum reaches
// this page - and no password is required to get in, because friction is what
// keeps tenants off a portal.
export default function TenantLoginPage() {
  return (
    <AuthCard
      title="Sign in"
      description="Enter the email address on your lease and we will send you a sign-in link. There is no password to remember."
    >
      <AuthForm action={requestTenantMagicLink} submitLabel="Email me a link">
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoFocus
        />
      </AuthForm>
    </AuthCard>
  )
}
