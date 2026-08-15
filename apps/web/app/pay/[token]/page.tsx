import { formatCents } from '@rental/core/money'
import { CARD_FIXED_CENTS, CARD_RATE_BPS } from '@rental/core/payments'
import { PayForm } from '@/components/payments/pay-form.tsx'
import { startPaymentFromLink } from '@/lib/payments/actions.ts'
import { paymentView } from '@/lib/payments/queries.ts'
import { payLinkRejection, verifyPayLink } from '@/lib/portal/pay-link.ts'

export const metadata = {
  title: 'Pay your rent',
  // A magic link in a text message must never be indexed, and the URL itself
  // is the credential — the same rule the vendor and verify links follow.
  robots: { index: false, follow: false },
}

// Pay rent from the link in the reminder (PAY-01, COMM-02, R-046).
//
// PUBLIC BY DESIGN: no session, no account. The token in the path is the
// entire credential and `verifyPayLink()` is the entire authorization — see
// lib/portal/pay-link.ts, and D-45 for why a token-scoped page is the right
// instrument here where "a portal session scoped to paying only" would be
// fail-open across twenty-four `requireTenant` call sites.
//
// It replaces a link to `/portal/pay`, which sits behind `requireTenant` and
// redirects to an EMAIL-ONLY login with no return-to. For a tenant with a
// phone and no email — R-021's whole persona — the message telling them to
// go and pay could not be acted on at all.
//
// NO `loading.tsx` HERE OR ABOVE. Nothing in this segment calls `notFound()`
// today, but the R-099 rule is about the segment, not the current code: a
// Suspense boundary streams a 200 before the page runs, and a status already
// on the wire cannot be retracted.

export const dynamic = 'force-dynamic'

export default async function PayLinkPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const link = await verifyPayLink(token)

  if (!link.ok) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          This link isn&rsquo;t working
        </h1>
        <p className="text-base">{payLinkRejection(link.reason)}</p>
      </main>
    )
  }

  // THE SAME VIEW THE SIGNED-IN PAY SCREEN BUILDS, from a scope narrowed to
  // the one lease this token names. Reusing it rather than assembling a
  // second "what do you owe" is the same reasoning as sharing the write
  // path: two implementations of a balance are two balances.
  const view = await paymentView({
    tenantId: link.tenantId,
    leaseIds: [link.leaseId],
    // No unit scope. Documents are reachable through `unitIds` (R-020's
    // shutoff-photo exception), and this token grants no document access at
    // all — an empty list is the honest expression of that.
    unitIds: [],
  })

  if (!view) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pay your rent</h1>
        <p className="text-base">
          There is nothing set up to pay against on this account yet. Please
          contact the office.
        </p>
      </main>
    )
  }

  const owesNothing = view.maxCents <= 0

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Hello {link.tenantFirstName}
        </h1>
        <p className="text-muted-foreground text-sm">
          {view.propertyName} — {view.unitName}
        </p>
      </header>

      <section aria-labelledby="balance" className="flex flex-col gap-1 rounded-lg border p-4">
        <h2 id="balance" className="text-muted-foreground text-sm font-medium">
          What you owe
        </h2>
        <p className="text-3xl font-semibold">{formatCents(Math.max(0, view.balanceCents))}</p>
        {view.inFlightCents > 0 && (
          <p className="text-muted-foreground text-sm">
            {formatCents(view.inFlightCents)} is already on its way and is not
            included above.
          </p>
        )}
      </section>

      {owesNothing ? (
        <p className="rounded-md border p-4">
          {view.inFlightCents > 0
            ? 'Everything you owe is already on its way. We will email you when it clears.'
            : 'Your balance is clear — there is nothing to pay right now.'}
        </p>
      ) : !view.hasPaymentMethod && view.collectionMethod === 'charge_automatically' ? (
        <p className="rounded-md border p-4">
          Your payment account is still being set up. Please contact the office
          and we will sort it out.
        </p>
      ) : (
        <PayForm
          view={view}
          // Bound server-side WITH THE TOKEN. A plain function cannot cross
          // this boundary — only a `'use server'` export has an identity the
          // client can call back to — and the action re-verifies the token
          // rather than trusting that this page rendered.
          action={startPaymentFromLink.bind(null, token)}
          cardRateBps={CARD_RATE_BPS}
          cardFixedCents={CARD_FIXED_CENTS}
        />
      )}

      <p className="text-muted-foreground text-xs">
        You don&rsquo;t need to sign in to pay from this link. It only opens this
        payment — nothing else on your account.
      </p>
    </main>
  )
}
