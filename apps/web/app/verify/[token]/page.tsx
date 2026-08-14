import { VerifyLinkForm } from '@/components/portal/verify-link-form.tsx'
import { answerFromLink } from '@/lib/portal/verify-link-actions.ts'
import { answeredMessage, rejectionMessage, verifyVerifyLink } from '@/lib/portal/verify-link.ts'

export const metadata = {
  title: 'Was this fixed?',
  // A magic link in a text message must never be indexed, and the URL itself
  // is the credential — the same rule the vendor link follows (D-16).
  robots: { index: false, follow: false },
}

// The tenant's one tap, without a login wall (MAINT-07, COMM-02, R-032c).
//
// PUBLIC BY DESIGN: no session, no account. The token in the path is the
// entire credential and `verifyVerifyLink()` is the entire authorization —
// see lib/portal/verify-link.ts for why a seven-day, scoped, answer-one-
// question token is defensible where a portal session would be the wrong
// instrument entirely.
//
// It replaces a link to `/portal/maintenance/<ticket>`, which sat behind
// `requireTenant` and redirected to an EMAIL-ONLY login with no return-to.
// For a tenant with a phone and no email — R-021's whole persona — the
// message asking "was this fixed?" could not be answered at all.
//
// NO `loading.tsx` HERE OR ABOVE. Nothing in this segment calls `notFound()`
// today, but the R-099 rule is about the segment, not the current code: a
// Suspense boundary streams a 200 before the page runs, and a status already
// on the wire cannot be retracted.

export const dynamic = 'force-dynamic'

export default async function VerifyLinkPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const link = await verifyVerifyLink(token)

  if (!link.ok) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {link.reason === 'answered' ? 'Thanks' : 'This link isn’t working'}
        </h1>
        {/* THIS IS ALSO THE SUCCESS SCREEN, which is not obvious. A server
            action re-renders the page it was called from, so the moment a
            tenant taps an answer this branch is what replaces the form — the
            client-side notice is unmounted before anybody reads it. Saying
            what they told us works for both readers: the person who just
            tapped, and the person reopening the link days later. */}
        <p className="text-base">
          {link.answer ? answeredMessage(link.answer.resolved) : rejectionMessage(link.reason)}
        </p>
      </main>
    )
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Was this fixed?</h1>
        <p className="text-muted-foreground text-sm">
          {link.job.propertyName} — {link.job.unitName}
        </p>
      </header>

      <section className="flex flex-col gap-2 rounded-md border p-4">
        <h2 className="text-sm font-medium">What you reported</h2>
        {/* THE TENANT'S OWN WORDS where we have them, not the internal scope.
            "Water heater leaking" is what they will recognise; "R/R T&P
            valve, 40gal" is not — the same choice the message itself makes. */}
        <p className="whitespace-pre-wrap text-sm">
          {link.job.requestSummary ?? link.job.scope}
        </p>
      </section>

      <VerifyLinkForm action={answerFromLink.bind(null, token)} />

      <p className="text-muted-foreground text-xs">
        You don&rsquo;t need to sign in to answer this. Your answer goes straight to
        whoever looks after this property.
      </p>
    </main>
  )
}
