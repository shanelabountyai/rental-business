// Validation for message writes (COMM-01, R-017). Hand-rolled, matching every
// other packages/core validate.ts in this repo.

import type { MessageChannel } from '@rental/db'

interface Violation {
  field: string
  message: string
}

/// Channels a staff member can send a conversation message on. PORTAL and
/// EMAIL and SMS only - CALL_LOG is a record of something that happened on
/// the phone, never something this product transmits.
export const OUTBOUND_CHANNELS = [
  'PORTAL',
  'EMAIL',
  'SMS',
] as const satisfies readonly MessageChannel[]

export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number]

/**
 * A single SMS segment is 160 GSM-7 characters; beyond that a message splits,
 * costs per segment, and on some carriers arrives out of order. 1600 is
 * Twilio's own hard ceiling (10 segments) and the point past which a text is
 * the wrong medium anyway.
 */
const MAX_SMS_LENGTH = 1600
const MAX_BODY_LENGTH = 20_000

export interface OutboundMessageInput {
  threadId: string
  channel: string
  body: string
}

export function validateOutboundMessage(
  input: OutboundMessageInput,
): Violation[] {
  const violations: Violation[] = []

  if (!input.threadId.trim()) {
    violations.push({ field: 'threadId', message: 'A message needs a thread.' })
  }
  if (!(OUTBOUND_CHANNELS as readonly string[]).includes(input.channel)) {
    violations.push({ field: 'channel', message: 'Choose a channel.' })
  }
  if (!input.body.trim()) {
    violations.push({ field: 'body', message: 'Write a message.' })
  } else if (input.channel === 'SMS' && input.body.length > MAX_SMS_LENGTH) {
    violations.push({
      field: 'body',
      message: `A text this long will not send reliably. Keep it under ${MAX_SMS_LENGTH} characters, or send it as an email.`,
    })
  } else if (input.body.length > MAX_BODY_LENGTH) {
    violations.push({ field: 'body', message: 'That message is too long.' })
  }

  return violations
}

export interface CallLogInput {
  threadId: string
  body: string
  /**
   * The instant the call happened, ALREADY resolved to UTC from the
   * property's timezone by the caller - see `wallClockToUtc` in
   * packages/core/scheduling. Null when the submitted value was unparseable.
   *
   * A Date rather than the raw form string, deliberately: a
   * `datetime-local` field submits no timezone, so a string reaching this
   * function could only be interpreted in whatever zone the SERVER happens to
   * run in, which is the bug this signature exists to make unrepresentable
   * (D-3: UTC in the database, property-local for display).
   */
  occurredAt: Date | null
}

/**
 * A logged phone call (COMM-01: "staff phone calls are logged as timestamped
 * call notes in the same thread - contemporaneous notes carry legal weight").
 *
 * `occurredAt` is separate from when the note was typed, and may be well in
 * the past: somebody writing up a call twenty minutes later is the normal
 * case, and forcing the note's timestamp to be the typing time would misdate
 * the evidence. A FUTURE time is refused, because a contemporaneous note
 * about a call that has not happened yet is not a thing.
 */
export function validateCallLog(
  input: CallLogInput,
  now: Date = new Date(),
): Violation[] {
  const violations: Violation[] = []

  if (!input.threadId.trim()) {
    violations.push({ field: 'threadId', message: 'A call note needs a thread.' })
  }
  if (!input.body.trim()) {
    violations.push({
      field: 'body',
      message: 'Write down what was said - that is the whole value of the note.',
    })
  }

  if (!input.occurredAt || Number.isNaN(input.occurredAt.getTime())) {
    violations.push({ field: 'occurredAt', message: 'When was the call?' })
  } else if (input.occurredAt.getTime() > now.getTime() + 60_000) {
    // A minute of slack for clock skew between the browser and the server.
    violations.push({
      field: 'occurredAt',
      message: 'A call note cannot be dated in the future.',
    })
  }

  return violations
}
