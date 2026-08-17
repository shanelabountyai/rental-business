/**
 * Mapping a provider's delivery status onto ours (R-040e).
 *
 * WHY THIS EXISTS AT ALL. `SENT` in this system has meant *the provider
 * accepted the message*, which is not the same claim as *it arrived* — and
 * for `entry_notice`, which is legally significant and which a tenant is not
 * permitted to switch off, the difference between those two sentences is the
 * whole evidentiary value of the record. A log that cannot tell them apart
 * can be silently false, and this build's premise is that the evidence trail
 * IS the product.
 *
 * Pure, and in core, because it is a decision rather than an integration: the
 * webhook route does signature checking and database writes, and this says
 * what the status means. It also means the simulator can be made to answer
 * the way a carrier does without the answer being derived from our own state
 * (D-27).
 */

/// Twilio's `MessageStatus` values, as posted to a status callback.
export type ProviderDeliveryStatus =
  | 'accepted'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed'
  | 'read'

/// What we record. A subset of DeliveryStatus - a callback can never move a
/// row to SUPPRESSED or DEFERRED, which are decisions we made before sending.
/// BOUNCED is Resend's vocabulary, not Twilio's - see `mapResendEventStatus`
/// below - but it is ranked alongside the rest here rather than in a second
/// copy of RANK, because "may this overwrite what's recorded" has one answer
/// regardless of which provider is asking.
export type MappedDeliveryStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'BOUNCED' | null

/**
 * Provider error codes that mean "this number has opted out".
 *
 * 21610 is the one that matters: Twilio refuses the send because the
 * recipient replied STOP to this sending number. It is how we learn about an
 * opt-out the carrier absorbed and never forwarded to us, which is the COMMON
 * case rather than the edge one - so this, not the inbound keyword, is the
 * mechanism that actually keeps the record honest.
 *
 * 21211 is an unusable number and 30003/30005 are unreachable handsets; they
 * are failures but NOT opt-outs, and treating them as one would silently
 * unsubscribe somebody whose phone was merely off.
 */
const OPT_OUT_ERROR_CODES = new Set(['21610'])

export function isOptOutErrorCode(code: string | null | undefined): boolean {
  return code ? OPT_OUT_ERROR_CODES.has(code.trim()) : false
}

/**
 * Map a provider status onto ours.
 *
 * Returns null for the statuses that carry no new information — `accepted`,
 * `queued` and `sending` all describe a message still in flight, and writing
 * them would move a row backwards from SENT for no gain.
 *
 * `undelivered` and `failed` are both FAILED. Twilio distinguishes "the
 * carrier rejected it" from "we could not send it", and the reason is kept in
 * `failureCode`; for the question this column answers — did it arrive — they
 * are the same answer.
 */
export function mapDeliveryStatus(status: string): MappedDeliveryStatus {
  switch (status.trim().toLowerCase()) {
    case 'sent':
      return 'SENT'
    case 'delivered':
      return 'DELIVERED'
    case 'read':
      return 'READ'
    case 'undelivered':
    case 'failed':
      return 'FAILED'
    default:
      return null
  }
}

/**
 * Map a Resend webhook event type onto ours (R-054's bounce/failure path).
 *
 * Only the two events this build acts on. `email.delivery_delayed` and
 * `email.complained` carry no verdict this column can hold - a delay is not
 * a status change, and a spam complaint is a different fact from "did it
 * arrive" - so both fall through to null rather than being guessed at, the
 * same restraint `mapDeliveryStatus` shows Twilio's in-flight statuses.
 * `email.opened`/`email.clicked` are read receipts this product does not
 * track for email the way `READ` does for SMS.
 */
export function mapResendEventStatus(eventType: string): MappedDeliveryStatus {
  switch (eventType.trim().toLowerCase()) {
    case 'email.delivered':
      return 'DELIVERED'
    case 'email.bounced':
      return 'BOUNCED'
    default:
      return null
  }
}

/**
 * May this status overwrite what is already recorded?
 *
 * Callbacks are not ordered. Twilio promises delivery of each callback, not
 * that `sent` arrives before `delivered`, and a retried `sent` landing after
 * a `delivered` would otherwise walk the record backwards — the same class of
 * out-of-order hazard R-042 fixed in the Stripe projection, where a stale
 * decline reversed a payment that had already cleared.
 *
 * So the rank only ever increases. FAILED is terminal in the other direction:
 * a message that failed did not later arrive, and a late `sent` must not
 * erase the failure a human may already have acted on.
 */
const RANK: Record<Exclude<MappedDeliveryStatus, null>, number> = {
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  FAILED: 4,
  // Ranked above FAILED, not tied with it: a bounce is more specific than a
  // generic failure and must be able to overwrite one that already landed,
  // while a later generic FAILED must not erase a bounce already recorded.
  BOUNCED: 5,
}

export function shouldApplyStatus(
  incoming: Exclude<MappedDeliveryStatus, null>,
  current: string,
): boolean {
  // Never resurrect a decision made before sending. SUPPRESSED means we chose
  // not to send and DEFERRED means we have not sent yet; a callback about
  // either is about a message this row is not describing.
  if (current === 'SUPPRESSED' || current === 'DEFERRED') return false
  const currentRank = RANK[current as Exclude<MappedDeliveryStatus, null>] ?? 0
  return RANK[incoming] > currentRank
}
