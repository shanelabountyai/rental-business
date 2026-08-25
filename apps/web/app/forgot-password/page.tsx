import Link from 'next/link'
import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { requestPasswordReset } from '@/lib/auth/actions.ts'

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
