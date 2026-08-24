'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { CalendarFeedState } from '@/lib/calendar/actions.ts'

// Subscribing your own calendar to the day's visits (NOTIF-06, R-097c).
//
// THE LINK IS SHOWN ONCE, HERE, AND IS NOT STORED ANYWHERE READABLE. The
// token is hashed in the database like every other one in this product, so
// there is no "show it again" - only "make a new one", which is the same
// button and which kills the old link. That is the honest shape: a link that
// could be re-read is a link a stolen session can re-read.

export function CalendarFeedPanel({
  hasLink,
  action,
}: {
  hasLink: boolean
  action: () => Promise<CalendarFeedState>
}) {
  const [state, submit] = useActionState<CalendarFeedState, FormData>(async () => action(), {})

  return (
    <section aria-labelledby="calendar-feed" className="flex flex-col gap-3">
      <h2 id="calendar-feed" className="text-lg font-semibold">
        Your visit calendar
      </h2>
      <FormAlerts state={state} />
      <p className="text-muted-foreground text-sm">
        Showings, inspections and maintenance visits at the properties you can see, as a calendar
        your phone can subscribe to. It is read-only: changing something there changes nothing in
        the app, and your calendar decides how often it checks &mdash; usually hours, so this is
        where the day&rsquo;s visits come from and not where an urgent change is learned.
      </p>
      <p className="text-muted-foreground text-sm">
        It carries the address, the time and what kind of visit. It never carries a
        tenant&rsquo;s name or contact details.
      </p>

      {state.url && (
        <div className="flex flex-col gap-1 rounded-md border p-3">
          <p className="text-sm font-medium">Subscribe to this link</p>
          {/* Selectable and wrapped: it is pasted into a calendar app's
              "add by URL" box, on a phone, one-handed. */}
          <p className="font-mono text-sm break-all select-all">{state.url}</p>
          <p className="text-muted-foreground text-sm">
            Shown once. If you lose it, make a new one &mdash; that stops the old link working.
          </p>
        </div>
      )}

      {!state.url && (
        <form action={submit}>
          <SubmitButton label={hasLink ? 'Make a new calendar link' : 'Create my calendar link'} />
        </form>
      )}

      {hasLink && !state.url && (
        <p className="text-muted-foreground text-sm">
          You already have a link. Making a new one stops the old one working, which is what to do
          if it has ended up somewhere it should not be.
        </p>
      )}
    </section>
  )
}
