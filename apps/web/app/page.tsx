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
import Link from 'next/link'

export const dynamic = 'force-dynamic'

// THE PUBLIC FRONT DOOR (R-114, audit angle 8).
//
// This route rendered "Scaffold only", named `docs/prds/06-backlog.md`, and
// printed worked proration and late-fee-cap arithmetic - internal build notes
// on the one URL a stranger reaches by typing the domain. It had no link to
// either sign-in page, so the two people most likely to arrive here, a tenant
// who bookmarked the domain and a vendor who mistyped a magic link, hit a dead
// end that also leaked how the product is built.
//
// Deliberately just a signpost. There is no marketing site and this is not
// one: an owner-operator's tenants arrive by emailed link, and the only job
// left for this page is to say which door is which. Plain `<a>`s in a server
// component, so it works with no JavaScript at all - the same standard the
// vendor surface is held to, and for the same reason.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Rental Operations Platform
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Property management for the homes we look after.
        </p>
      </header>

      <nav aria-label="Sign in" className="flex flex-col gap-3">
        <Link
          href="/portal/login"
          className="border-input focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-4 py-2 text-base font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          I rent a home &mdash; sign in to my portal
        </Link>
        <Link
          href="/login"
          className="border-input focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-4 py-2 text-base font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          I work here &mdash; staff sign in
        </Link>
      </nav>

      {/* A vendor's link IS the credential (D-16), so there is nothing to sign
          into and no form to offer them - only the fact that the link they
          were sent is the way in, and what to do when it has expired. */}
      <p className="text-muted-foreground text-sm">
        Working on a job for us? Open the link we texted you &mdash; there is no
        account to create. If it has stopped working, call the office and we
        will send a new one.
      </p>
    </main>
  )
}
