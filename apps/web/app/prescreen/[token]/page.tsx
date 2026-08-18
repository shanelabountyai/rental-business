import { PrescreenForm } from '@/components/prospects/prescreen-form.tsx'
import { submitPrescreenAnswers } from '@/lib/prospects/prescreen-actions.ts'
import { prescreenLinkStatus } from '@/lib/prospects/prescreen-link.ts'

export const metadata = {
  title: 'A few questions',
  // Same rule as verify/[token] and pay/[token]: the URL itself is the
  // credential (D-16's posture, applied to a fourth zero-login purpose).
  robots: { index: false, follow: false },
}

// The prospect's identical pre-screening questions, answerable with no
// account (LEASE-07, R-058).
//
// PUBLIC BY DESIGN: no session, no account - a prospect has neither. The
// token in the path is the entire credential and `prescreenLinkStatus()` is
// the entire authorization, same shape as verify/[token] (R-032c) and
// pay/[token] (R-046).
//
// NO `loading.tsx` above this segment - the R-099 rule that a Suspense
// boundary streams a 200 before the page runs, which would undermine a
// future notFound() here even though none exists yet.
export const dynamic = 'force-dynamic'

// BOTH of these read as the success screen, and both mean the same thing to
// a prospect even though checkToken() reaches them by different routes.
//
// A server action re-renders the page it was called from, so the instant a
// prospect submits, `redeemToken()` burns the token and this branch is what
// replaces the form - the client-side "thanks" in the form's own state is
// unmounted before anybody reads it (the same dual-purpose framing
// verify/[token]'s own page comment documents for the identical reason).
// That reload lands on `already_used`, not `already_answered`: checkToken()
// sees the burned token before this page ever reads the Prospect row.
//
// `already_answered` is the sibling case where the TOKEN itself would still
// pass (a second, separately-issued one) but the Prospect record already
// shows an answer - see prescreen-link.ts's own comment for when that can
// happen. Different code path, identical thing to tell the person reading
// it.
const REJECTION_MESSAGES: Record<string, string> = {
  not_found: 'This link is not valid.',
  wrong_purpose: 'This link is not valid.',
  wrong_subject: 'This link is not valid.',
  expired: 'This link has expired. Reply to the message you received and we’ll send a new one.',
  already_used: "Thanks - we've got your answers and will be in touch.",
  already_answered: "Thanks - we've got your answers and will be in touch.",
}

export default async function PrescreenLinkPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const status = await prescreenLinkStatus(token)

  if (!status.ok) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {status.reason === 'already_used' || status.reason === 'already_answered'
            ? 'Thanks'
            : 'This link isn’t working'}
        </h1>
        <p className="text-base">
          {REJECTION_MESSAGES[status.reason] ?? 'This link is not valid.'}
        </p>
      </main>
    )
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Hi {status.prospect.firstName}, a few quick questions
        </h1>
        <p className="text-muted-foreground text-sm">
          We ask everyone who inquires about a listing the same five questions - it keeps
          things fair.
        </p>
      </header>
      <PrescreenForm action={submitPrescreenAnswers.bind(null, token)} />
    </main>
  )
}
