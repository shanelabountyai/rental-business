import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { completeStaffMfa } from '@/lib/auth/actions.ts'

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


export const metadata = { title: 'Two-factor code — Rental Operations' }

export default function MfaChallengePage() {
  return (
    <AuthCard
      title="Enter your code"
      description="Open your authenticator app and enter the six-digit code. If you have lost your phone, enter one of your recovery codes instead."
    >
      <AuthForm action={completeStaffMfa} submitLabel="Verify">
        {/*
          Not type="number": a spinner on a one-time code is useless, and
          leading zeros get eaten. inputMode brings up the numeric keypad on a
          phone without any of that.
        */}
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
