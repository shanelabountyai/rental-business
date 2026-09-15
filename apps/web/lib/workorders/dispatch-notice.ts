import { friendlyTimestamp } from '@rental/core/scheduling'
import type { ChannelOutcome } from '@/lib/notifications/send.ts'

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
 * QUEUED beats DEFERRED beats suppressed: if any channel is going now the
 * message is on its way and the rest is detail. A `duplicate` outcome carries
 * no status at all - this exact send was already decided, so it is neither a
 * new send nor a failure, and it reaches the last line only when nothing else
 * happened either.
 */
export function vendorDispatchNotice(
  outcomes: readonly ChannelOutcome[],
  vendorName: string,
  timezone: string,
): string {
  if (outcomes.some((outcome) => outcome.status === 'QUEUED')) {
    return `Link sent to ${vendorName}.`
  }
  const deferred = outcomes.find((outcome) => outcome.status === 'DEFERRED')
  if (deferred?.sendAfter) {
    // Names the hour rather than saying "held for quiet hours", because the
    // decision it informs is whether to phone the vendor instead, and that
    // depends on how long the wait is. Property-local and zone-labelled: the
    // PM may not be in the same timezone as the house.
    return `Quiet hours at this property — the link goes to ${vendorName} at ${friendlyTimestamp(deferred.sendAfter, timezone)}. Set the job to EMERGENCY priority to send it now, or call them.`
  }
  return `Not sent to ${vendorName} — no address we may use. Copy the link from the work order and send it yourself.`
}
