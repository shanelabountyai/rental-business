import { friendlyTimestamp } from '@rental/core/scheduling'
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

      {/* WHAT WE DID, which this page never said (R-141). "Was this fixed?"
          over the tenant's own report and nothing else asks somebody to
          confirm a visit they may not have been home for, three days after
          it happened. The SCOPE is the right text here even though the
          section above deliberately avoids it: above, the question is what
          they recognise as their own complaint; here, it is the record of
          the work, and "R/R T&P valve, 40gal" is what was actually done. */}
      <section className="flex flex-col gap-2 rounded-md border p-4">
        <h2 className="text-sm font-medium">What we did</h2>
        <p className="whitespace-pre-wrap text-sm">{link.job.scope}</p>
        {link.job.completedAt && (
          <p className="text-muted-foreground text-sm">
            {link.job.vendorName ?? 'Our maintenance team'} marked this finished on{' '}
            {friendlyTimestamp(link.job.completedAt, link.job.timezone)}.
          </p>
        )}

        {/* THE PHOTO, which is the answer to the question this page asks
            (R-142). MAINT-06 makes a completion photo mandatory before a job
            can reach WORK_COMPLETE, so this list is never empty here — and
            somebody who was out when the vendor came has no other way to see
            what was done. Bytes go out through a token-scoped route that
            re-checks the credential; this page rendering the URL is not the
            authorization.

            `unoptimized`-equivalent plain <img> rather than next/image: the
            source is a dynamic authenticated route, not a static asset, and
            the optimizer would need its own access to fetch it. */}
        {link.job.photoIds.length > 0 && (
          <ul className="flex flex-col gap-2">
            {link.job.photoIds.map((photoId, index) => (
              <li key={photoId}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/verify/${token}/photos/${photoId}`}
                  alt={`The finished work, photo ${index + 1} of ${link.job.photoIds.length}`}
                  className="w-full rounded-md border"
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <VerifyLinkForm action={answerFromLink.bind(null, token)} />

      <p className="text-muted-foreground text-xs">
        You don&rsquo;t need to sign in to answer this. Your answer goes straight to
        whoever looks after this property.
      </p>
    </main>
  )
}
