import { SignForm } from '@/components/leases/sign-form.tsx'
import { signLeaseDocument } from '@/lib/leases/esign-actions.ts'
import { markSignerViewed, verifySignerLink } from '@/lib/leases/sign-link.ts'

export const metadata = {
  title: 'Sign your lease',
  // A magic link must never be indexed, and the URL itself is the
  // credential - the same rule every other token-scoped page here follows.
  robots: { index: false, follow: false },
}

// One signer's own review-and-sign page (LEASE-06, DOC-02, R-063).
//
// PUBLIC BY DESIGN: no session, no account - the token in the path is the
// entire credential, `verifySignerLink()` the entire authorization, the
// same D-45 shape /pay/[token] and /vendor/[token] already use. A leaked
// link can see and sign THIS ONE LEASE as THIS ONE SIGNER; nothing else.
//
// NO `loading.tsx` HERE OR ABOVE - the R-099 rule about a Suspense boundary
// streaming a 200 before the page runs. Nothing here calls `notFound()`
// today, but the rule is about the segment, not the current code.

export const dynamic = 'force-dynamic'

export default async function SignLinkPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const link = await verifySignerLink(token)

  if (!link.ok) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">This link isn&rsquo;t working</h1>
        <p className="text-base">
          {link.reason === 'expired'
            ? 'This signing link has expired. Contact your property manager for a new one.'
            : 'This signing link is not working. Contact your property manager.'}
        </p>
      </main>
    )
  }

  // Recorded on the first render that finds it live - see markSignerViewed's
  // own idempotency guard for why this is safe to call on every visit.
  await markSignerViewed(link.signerId)

  const where = `${link.propertyName} — ${link.unitName}`

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Hello {link.name}</h1>
        <p className="text-muted-foreground text-sm">{where}</p>
      </header>

      {link.documentId && (
        <a
          href={`/sign/${token}/document`}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border p-4 text-center font-medium underline underline-offset-4"
        >
          Read the lease before signing
        </a>
      )}

      {link.envelopeStatus === 'VOIDED' ? (
        <p className="rounded-md border p-4">
          This lease was withdrawn. Contact your property manager for a new link.
        </p>
      ) : link.status === 'SIGNED' ? (
        // COVERS THE JUST-SIGNED CASE TOO, not only a repeat visit. A form
        // action always triggers a refresh of the Server Component tree
        // once it completes, which re-runs `verifySignerLink` and lands
        // here immediately - so this is the ONLY message a signer who just
        // submitted actually sees; `SignForm`'s own local `useActionState`
        // notice is unmounted before it can paint. See this page's own
        // header for why there is no separate "thank you" screen.
        <p className="rounded-md border p-4">
          {link.envelopeStatus === 'COMPLETED'
            ? 'You have signed this lease. Every signer has now completed, and the lease is active.'
            : 'You have signed this lease. Still waiting on the remaining signer(s) - you can read it above at any time.'}
        </p>
      ) : (
        <SignForm action={signLeaseDocument.bind(null, token)} />
      )}

      <p className="text-muted-foreground text-xs">
        You don&rsquo;t need to sign in to sign this lease. This link only opens your own
        signature on this one document.
      </p>
    </main>
  )
}
