import {
  SELF_SHOWING_REFUSAL_MESSAGES,
  canIssueSelfShowingCode,
  friendlyTimestamp,
} from '@rental/core/scheduling'
import { SelfShowingIdentityForm } from '@/components/showings/self-showing-form.tsx'
import { revealShowingCode, verifyIdentityForShowing } from '@/lib/showings/access-actions.ts'
import { showingAccessLinkStatus } from '@/lib/showings/access-link.ts'

export const metadata = {
  title: 'Your viewing',
  // Never indexed. Same rule as every other token-scoped page here, and it
  // matters more on this one than most.
  robots: { index: false, follow: false },
}

// The prospect's link to the door (LEASE-08, R-094).
//
// ==========================================================================
// THE CODE LIVES ON THIS PAGE AND NOWHERE ELSE. It is not in the SMS, not in
// the email and not in the URL - which is what makes the instant kill mean
// something: a code pasted into a message is live for as long as the message
// exists, on a phone that may be lent, forwarded or backed up, and no
// revocation reaches it. Here, the decision is re-run on every render, so
// pulling a code takes effect on the prospect's next refresh.
//
// `force-dynamic` is load-bearing rather than habit: a cached render of this
// page is a cached entry code.
//
// PUBLIC BY DESIGN - no session, no account, the token is the credential -
// and NO `loading.tsx` here or above (R-099's rule).
// ==========================================================================

export const dynamic = 'force-dynamic'

const REJECTION_MESSAGES: Record<string, string> = {
  not_found: 'This link is not valid.',
  wrong_purpose: 'This link is not valid.',
  wrong_subject: 'This link is not valid.',
  expired:
    'This link has expired. Call the office and they will send you a new one — it takes a moment.',
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </main>
  )
}

export default async function SelfShowingAccessPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const link = await showingAccessLinkStatus(token)

  if (!link.ok) {
    return (
      <Shell title="This link isn’t working">
        <p className="text-base">{REJECTION_MESSAGES[link.reason] ?? 'This link is not valid.'}</p>
      </Shell>
    )
  }

  const when = friendlyTimestamp(link.scheduledStart, link.timezone)
  const revealed = await revealShowingCode(token, new Date())
  // Asked BEFORE the ID form is offered. Somebody whose viewing was
  // cancelled, or whose house was let this morning, should be told that
  // rather than asked for a driving licence and refused afterwards.
  const gate = canIssueSelfShowingCode({
    unitStatus: link.unitStatus,
    hasActiveSmartLock: link.smartLock?.active === true,
    showingStatus: link.showingStatus,
    scheduledStart: link.scheduledStart,
    scheduledEnd: link.scheduledEnd,
    identity: { result: 'VERIFIED', namesAgree: true },
  })

  return (
    <Shell title="Your viewing">
      <p className="text-base">
        {link.addressLine1}
        {link.unitName ? ` (${link.unitName})` : ''}, {when}. You are letting yourself in.
      </p>

      {revealed?.code ? (
        <div className="flex flex-col gap-2 rounded-md border p-4">
          <p className="text-sm font-medium">Your entry code</p>
          {/* Wide tracking and a large size on purpose: this is read off a
              phone in daylight, one-handed, at a door. */}
          <p className="font-mono text-4xl tracking-[0.3em]">{revealed.code}</p>
          <p className="text-muted-foreground text-sm">
            It works until {friendlyTimestamp(revealed.validTo, link.timezone)}. Please lock up
            behind you when you leave.
          </p>
        </div>
      ) : revealed ? (
        <div className="flex flex-col gap-2 rounded-md border p-4">
          <p className="text-base">{revealed.refusalMessage}</p>
          {/* Said even when the code is not live yet, because "when does it
              start" is the question somebody standing outside is asking. */}
          <p className="text-muted-foreground text-sm">
            Your code is live from {friendlyTimestamp(revealed.validFrom, link.timezone)} until{' '}
            {friendlyTimestamp(revealed.validTo, link.timezone)}.
          </p>
        </div>
      ) : gate.refusal ? (
        <p className="rounded-md border p-4 text-base">
          {SELF_SHOWING_REFUSAL_MESSAGES[gate.refusal]}
        </p>
      ) : (
        <SelfShowingIdentityForm action={verifyIdentityForShowing.bind(null, token)} />
      )}
    </Shell>
  )
}
