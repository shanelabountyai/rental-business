import {
  MaintenanceWizard,
  type WizardParams,
} from '@/components/portal/maintenance/maintenance-wizard.tsx'
import { clarifyRejectionMessage, verifyClarifyLink } from '@/lib/maintenance/clarify-link.ts'
import {
  submitClarification,
  submitClarificationForm,
  uploadClarificationPhoto,
} from '@/lib/maintenance/clarify-actions.ts'

export const metadata = {
  title: 'A few questions about your request',
  // A magic link in a text message must never be indexed, and the URL itself
  // is the credential — the same rule the vendor, verify and pay links follow
  // (D-6, D-16, D-45).
  robots: { index: false, follow: false },
}

// The clarifying questions and troubleshooting script a texted-in request
// never got asked (MAINT-01, MAINT-02, R-177).
//
// PUBLIC BY DESIGN: no session, no account. The token in the path is the
// entire credential and `verifyClarifyLink()` is the entire authorization —
// see lib/maintenance/clarify-link.ts for why, and for what a leaked one can
// and cannot reach. Linking into `/portal/maintenance/...` instead would be
// the dead end R-032c already removed once: that sits behind `requireTenant`,
// which redirects to an EMAIL-ONLY login with no return-to, and the tenant
// this whole item exists for is the one with a phone and no email.
//
// IT IS THE SAME WIZARD the portal renders, with three actions swapped
// (R-177). Same questions, same seven scripts, same illustrations, same
// URL-driven no-JavaScript path — a second copy would be a second place for
// them to drift, and this is the copy nobody would remember to update.
//
// NO `loading.tsx` HERE OR ABOVE. Nothing in this segment calls `notFound()`
// today, but the R-099 rule is about the segment, not the current code: a
// Suspense boundary streams a 200 before the page runs, and a status already
// on the wire cannot be retracted.

export const dynamic = 'force-dynamic'

export default async function ClarifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<WizardParams>
}) {
  const { token } = await params
  // The wizard's answers live in the query string (R-111), so pressing Next
  // before the page has hydrated - or with no JavaScript at all - is an
  // ordinary navigation rather than a tap that does nothing. Everything here
  // is clamped by `reachableStep` inside the wizard; nothing is trusted.
  const initial = await searchParams
  const link = await verifyClarifyLink(token)

  if (!link.ok) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {link.reason === 'answered' ? 'Thanks' : 'This link isn’t working'}
        </h1>
        {/* THIS IS ALSO THE SUCCESS SCREEN. The token is burned on submit, so
            the moment a tenant sends their answers this branch is what
            replaces the wizard — and it is equally right for somebody
            reopening the link tomorrow. */}
        <p className="text-base">{clarifyRejectionMessage(link.reason)}</p>
      </main>
    )
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          A few questions about your request
        </h1>
        <p className="text-muted-foreground text-sm">
          {link.propertyName} — {link.unitName}
        </p>
      </header>

      <section className="flex flex-col gap-2 rounded-md border p-4">
        <h2 className="text-sm font-medium">What you told us</h2>
        {/* THE TENANT'S OWN WORDS, and only those. `reportedWords` exists
            precisely so the staff-facing tail of the description — "may not
            use the portal — reply by text" — never reaches the one person it
            is not written for (D-10). */}
        <p className="whitespace-pre-wrap text-sm">{link.reported}</p>
      </section>

      <p className="text-base">
        Some of these turn out to be a five-minute fix. Answering takes about a
        minute and means we send the right person with the right parts.
      </p>

      <MaintenanceWizard
        // A category a PM already set during triage is the SEED, not a
        // constraint - the tenant still sees the radio, and their own answer
        // still lands in the transcript, but they open on the right set of
        // clarifying questions instead of guessing. Anything already in the
        // URL wins, because that is the tenant mid-flow.
        initial={{ category: link.triagedCategory ?? undefined, ...initial }}
        submitLabel="Send answers"
        actions={{
          // Bound server-side, because a plain function cannot cross the
          // Server→Client boundary — only a `'use server'` export has an
          // identity the client can call back to, and `npm run build` does
          // not catch the difference.
          submit: submitClarification.bind(null, token),
          formAction: submitClarificationForm.bind(null, token),
          uploadPhoto: uploadClarificationPhoto.bind(null, token),
          // Back to this page. The token is burned by then, so it renders
          // the "we have your answers" branch above.
          doneHref: `/clarify/${token}`,
        }}
      />

      <p className="text-muted-foreground text-xs">
        You don&rsquo;t need to sign in. If you would rather not answer, that is
        fine — text us and we will call you.
      </p>
    </main>
  )
}
