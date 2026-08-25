import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { requestTenantMagicLink } from '@/lib/auth/actions.ts'

// STATICALLY PRERENDERED UNTIL D-138, AND THAT SILENTLY BROKE EVERY SCRIPT
// ON IT. The CSP carries a per-request nonce, and prerendered HTML is fixed
// at build time - so there is no request for a nonce to come from, and Next
// stamps none. `'strict-dynamic'` then makes `'self'` inert, so all fourteen
// script tags on this page were refused by the browser. Nothing went red:
// this product uses real `<form action>` rather than `onClick`, so the page
// still worked server-side, which is exactly how it stayed invisible.
//
// Rendering per request is what lets the nonce exist. The cost is one
// uncached render of a page nobody hits in a loop; the alternative is a
// policy this page cannot satisfy.
export const dynamic = 'force-dynamic'


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
