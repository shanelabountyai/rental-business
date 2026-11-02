import Link from 'next/link'
import { LeaveSupportSessionForm } from '@/components/support/support-session-banner.tsx'
import { leaveSupportSession } from '@/lib/support/session-actions.ts'
import { type SupportEndReason, currentSupportSession } from '@/lib/support/session.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Support session ended' }

// PRD 11 §4.7 (R-295b): where a support session lands once its grant stops
// opening anything - ended from either side, revoked, expired, or its admin
// deactivated. It says which, from the visitor's own cookie and the one grant
// that cookie names; a visitor without one is told only that there is none.

const WHY: Record<SupportEndReason, string> = {
  ended_by_support: 'Platform support ended this session.',
  revoked: "An owner of this organisation revoked support's access.",
  expired: 'The time this access was granted for has run out.',
  admin_deactivated: 'The platform admin account behind this session was signed out or deactivated.',
  wrong_host: 'This session belongs to another organisation and opens nothing here.',
  invalid: 'This session no longer matches an open grant.',
}

export default async function SupportEndedPage() {
  const session = await currentSupportSession()
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-4 p-6 text-sm break-words">
      <h1 className="text-2xl font-semibold tracking-tight">
        {session?.live ? 'Your support session is still open' : 'Support session ended'}
      </h1>
      {!session ? (
        <p>There is no support session here. If you came from the platform console, open the grant again from there: each entry link works once, for one minute.</p>
      ) : session.live ? (
        <p>
          <Link href="/dashboard" className="underline underline-offset-4">
            Back to {session.grant.organization.name}
          </Link>
        </p>
      ) : (
        <>
          <p>{WHY[session.why]} Nothing more can be viewed under it.</p>
          <LeaveSupportSessionForm action={leaveSupportSession} />
        </>
      )}
    </main>
  )
}
