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
// THE TWO COMMONEST MAGIC-LINK FAILURES BOTH REDIRECT HERE WITH A REASON IN
// THE QUERY STRING (R-114, audit angle 9). Until now this page took no
// `searchParams` and rendered nothing, so a tenant whose link had expired -
// or, far more often, whose own email provider had prefetched and burned it -
// saw the identical screen they started on, with no indication anything had
// happened at all. `/portal/verify` even carries a comment anticipating the
// prefetcher case; the page it redirects TO never read the parameter. An error
// channel with no consumer is indistinguishable from no error handling, and it
// looks handled in code review.
//
// A FULL DOCUMENT LOAD, not a client navigation - `/portal/verify` is a route
// handler and its `redirect()` is one the browser follows. So there is no Next
// route announcer to speak the change, which is why `autoFocus` gives way when
// a message is present: pulling focus into the email field would skip the
// banner for the one person who most needs to hear it. That is also why this
// is a plain banner rather than a live region (R-107b's rule for `?param`
// banners arriving from a different route).
const LINK_ERRORS: Record<string, string> = {
  invalid:
    'That sign-in link has stopped working. Links only work once and they expire after a while - and some email apps open them before you do. Enter your email below and we will send a fresh one.',
  missing:
    'That sign-in link was incomplete - some email apps cut long links in half. Enter your email below and we will send a fresh one.',
}

export default async function TenantLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  // An unrecognised code still gets the ordinary message. A tenant who has
  // landed here from a link that did not work needs to be told to ask for
  // another one, whatever we failed to classify.
  const message = error ? (LINK_ERRORS[error] ?? LINK_ERRORS.invalid) : null

  return (
    <AuthCard
      title="Sign in"
      description="Enter the email address on your lease and we will send you a sign-in link. There is no password to remember."
    >
      {message && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {message}
        </p>
      )}
      <AuthForm action={requestTenantMagicLink} submitLabel="Email me a link">
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
