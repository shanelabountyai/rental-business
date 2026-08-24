import { friendlyTimestamp } from '@rental/core/scheduling'
import { ShowingBookingForm } from '@/components/showings/showing-booking-form.tsx'
import { bookShowing } from '@/lib/showings/actions.ts'
import { availableSlotsFor } from '@/lib/showings/queries.ts'
import { showingLinkStatus } from '@/lib/showings/link.ts'

export const metadata = {
  title: 'Book a showing',
  // A magic link must never be indexed - same rule as every other
  // token-scoped page here.
  robots: { index: false, follow: false },
}

// A prospect's own self-serve slot booking (LEASE-08, R-064).
//
// PUBLIC BY DESIGN: no session, no account. The token in the path is the
// entire credential, `showingLinkStatus()` the entire authorization - same
// D-45 shape /prescreen/[token] and /sign/[token] already use.
//
// NO `loading.tsx` HERE OR ABOVE - the R-099 rule (a Suspense boundary
// streams a 200 before the page runs). Nothing here calls `notFound()`
// today, but the rule is about the segment, not the current code.

export const dynamic = 'force-dynamic'

const REJECTION_MESSAGES: Record<string, string> = {
  not_found: 'This link is not valid.',
  wrong_purpose: 'This link is not valid.',
  wrong_subject: 'This link is not valid.',
  expired: 'This link has expired. Reply to the message you received and we’ll send a new one.',
}

export default async function ShowingBookingPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const link = await showingLinkStatus(token)

  if (!link.ok) {
    if (link.booked) {
      return (
        <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
          <h1 className="text-2xl font-semibold tracking-tight">You&rsquo;re booked</h1>
          <p className="text-base">
            {link.booked.addressLine1}
            {link.booked.unitName ? ` (${link.booked.unitName})` : ''}, {' '}
            {friendlyTimestamp(link.booked.scheduledStart, link.booked.timezone)}.{' '}
            {link.booked.selfService
              ? 'You are letting yourself in — use the entry-code link we sent you separately.'
              : 'A member of our team will meet you there.'}
          </p>
        </main>
      )
    }
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">This link isn&rsquo;t working</h1>
        <p className="text-base">{REJECTION_MESSAGES[link.reason] ?? 'This link is not valid.'}</p>
      </main>
    )
  }

  const slots = await availableSlotsFor(
    { id: link.unitId, status: link.unitStatus },
    { state: link.state, county: link.county, timezone: link.timezone },
    new Date(),
  )

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Hi {link.firstName}</h1>
        <p className="text-muted-foreground text-sm">
          {link.addressLine1}
          {link.unitName ? ` (${link.unitName})` : ''}
        </p>
      </header>
      <ShowingBookingForm
        action={bookShowing.bind(null, token)}
        slots={slots.map((s) => s.toISOString())}
        timezone={link.timezone}
      />
    </main>
  )
}
