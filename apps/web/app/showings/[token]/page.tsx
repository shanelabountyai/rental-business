import { formatCents } from '@rental/core/money'
import {
  DEFAULT_SHOWING_WINDOW,
  friendlyBusinessDate,
  friendlyTimestamp,
  utcToBusinessDate,
} from '@rental/core/scheduling'
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

  // Size as one line rather than a definition list, and only the parts that
  // are actually recorded - a listing with no square footage should say
  // nothing about square footage rather than "- sq ft".
  const size = [
    link.bedrooms !== null ? `${link.bedrooms} bed` : null,
    link.bathrooms !== null ? `${link.bathrooms} bath` : null,
    link.squareFeet !== null ? `${link.squareFeet.toLocaleString('en-US')} sq ft` : null,
  ].filter(Boolean)

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Hi {link.firstName}</h1>
        <p className="text-muted-foreground text-sm">
          {link.addressLine1}
          {link.unitName ? ` (${link.unitName})` : ''}
        </p>
      </header>

      {/* R-141. Before this the page named the prospect and the street and
          stopped, which asks somebody to book a viewing of a home the page
          declines to describe. `availableOn` is a `@db.Date` and goes through
          `utcToBusinessDate` - `friendlyDate` would move it a day west of
          UTC (D-3, R-042). */}
      <section className="flex flex-col gap-2 rounded-md border p-4">
        <h2 className="text-sm font-medium">What you&rsquo;re coming to see</h2>
        {/* THE PHOTOS, through the PUBLIC listing route rather than a new
            token-scoped one (R-142). These are the same bytes the published
            listing page already serves to anybody, so a second credential
            would be protecting nothing - and `showingLinkStatus` returns an
            empty list unless the listing is PUBLISHED, so the route's own
            publication check and this page can never disagree.

            Plain <img>, not next/image: the source is a dynamic route, not
            a static asset. */}
        {link.photoIds.length > 0 && (
          <ul className="flex flex-col gap-2">
            {link.photoIds.map((photoId, index) => (
              <li key={photoId}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/listings/${link.listingId}/photos/${photoId}`}
                  alt={`${link.addressLine1}, photo ${index + 1} of ${link.photoIds.length}`}
                  className="w-full rounded-md border"
                />
              </li>
            ))}
          </ul>
        )}
        {link.headline && <p className="text-base">{link.headline}</p>}
        <p className="text-base font-medium">{formatCents(link.rentCents)} a month</p>
        {size.length > 0 && <p className="text-sm">{size.join(' \u00b7 ')}</p>}
        <p className="text-muted-foreground text-sm">
          Available from {friendlyBusinessDate(utcToBusinessDate(link.availableOn))}.
        </p>
      </section>

      {/* WHAT HAPPENS NEXT, before they commit rather than after. The escort
          answer was only ever on the confirmation screen, and it is the one
          fact that decides whether this is a trip they can make alone. */}
      <p className="text-muted-foreground text-sm">
        Viewings last {DEFAULT_SHOWING_WINDOW.slotMinutes} minutes.{' '}
        {link.selfService
          ? 'You let yourself in — once you have booked we send you an entry-code link separately.'
          : 'A member of our team will meet you there.'}{' '}
        {/* AND WHAT HAPPENS AFTER IT (R-142). This deliberately does not
            promise an application link will arrive on its own: an
            APPLICATION_LINK is minted for an `Applicant`, a record that does
            not exist until somebody creates it, and it is sent by a member
            of staff. A page that promised one automatically would be
            describing a flow the product does not have. */}
        If you want to apply after seeing it, tell us and we&rsquo;ll send you an
        application link.
      </p>

      <ShowingBookingForm
        action={bookShowing.bind(null, token)}
        slots={slots.map((s) => s.toISOString())}
        timezone={link.timezone}
      />
    </main>
  )
}
