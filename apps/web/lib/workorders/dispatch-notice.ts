import { friendlyTimestamp } from '@rental/core/scheduling'
import type { ChannelOutcome } from '@/lib/notifications/send.ts'
import { reachOf } from '@/lib/notifications/reach.ts'

/**
 * What actually happened to the vendor's message, in one sentence (R-207).
 *
 * `Link sent to ${name}.` was returned unconditionally - including over a
 * delivery the engine had DEFERRED to 08:00, and over one it had suppressed
 * because the vendor has neither an email nor a phone on file. The PM reads
 * that sentence and stops thinking about the vendor, which is the whole
 * failure: this screen is the only place anybody would ever learn the plumber
 * was not called.
 *
 * ITS OWN MODULE because `actions.ts` is `'use server'` and may export only
 * async functions - a sync export there passes typecheck and vitest and fails
 * `npm run build`. Pure, so the three branches are held by a unit test
 * instead of by an e2e that would have to put the wall clock inside quiet
 * hours to reach the middle one.
 *
 * QUEUED beats already-sent beats DEFERRED beats suppressed - `reachOf`
 * holds that order now (R-211 generalised it to the four other callers that
 * were making the same claim without reading the outcome at all).
 */
export function vendorDispatchNotice(
  outcomes: readonly ChannelOutcome[],
  vendorName: string,
  timezone: string,
): string {
  const reach = reachOf(outcomes)
  switch (reach.status) {
    case 'SENT':
      return `Link sent to ${vendorName}.`
    // R-207 let a duplicate fall through to "Not sent", which was wrong in
    // the one direction that matters: the link had in fact gone.
    case 'ALREADY_SENT':
      return `Link already sent to ${vendorName}.`
    case 'DEFERRED':
      // Names the hour rather than saying "held for quiet hours", because the
      // decision it informs is whether to phone the vendor instead, and that
      // depends on how long the wait is. Property-local and zone-labelled: the
      // PM may not be in the same timezone as the house.
      return reach.sendAfter
        ? `Quiet hours at this property — the link goes to ${vendorName} at ${friendlyTimestamp(reach.sendAfter, timezone)}. Set the job to EMERGENCY priority to send it now, or call them.`
        : `Quiet hours at this property — the link goes to ${vendorName} when they end. Set the job to EMERGENCY priority to send it now, or call them.`
    case 'NOT_SENT':
      return `Not sent to ${vendorName} — ${reach.why}. Copy the link from the work order and send it yourself.`
  }
}
