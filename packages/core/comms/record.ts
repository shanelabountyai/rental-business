// The unified communications record (COMM-05, R-052). Pure - the database
// half lives in apps/web/lib/comms/transcript.ts.
//
// ==========================================================================
// WHAT THIS ITEM ACTUALLY FOUND, AND WHY THIS FILE EXISTS.
//
// COMM-05 asks that "every message, notice and delivery event writes to an
// immutable audit log". Read as a build instruction that sounds like a new
// table. It is not one, and adding one would have made the record WORSE:
//
//   `Message` is append-only by trigger (R-002).  `Notification` is
//   append-only by trigger (R-016).  `NoticeDelivery` is append-only by
//   trigger (R-051).  `AuditLog` is append-only by trigger.
//
// The immutability COMM-05 asks for has been enforced in Postgres for four
// items. Copying each row into a fifth table would duplicate evidence into a
// second place that can drift from the first, and "which of these two records
// of the same message is the real one" is the exact question an evidence
// trail exists to never have to answer.
//
// The REAL gap is a read. Those tables have never been read together, and a
// thread transcript today shows `Message` rows only - so it omits every
// notification the engine sent that tenant. Rent reminders, late notices,
// entry notices and payment receipts are all `Notification` rows. A transcript
// handed to a court showing the tenant's texts but not one of the eleven
// reminders we sent them is not a partial record, it is a misleading one: the
// omission argues the landlord's own case against them.
//
// So this file merges, and writes nothing.
// ==========================================================================

import type { SuppressionReason } from '../notifications/preferences.ts'

export const COMMS_ENTRY_KINDS = ['MESSAGE', 'NOTIFICATION', 'NOTICE'] as const
export type CommsEntryKind = (typeof COMMS_ENTRY_KINDS)[number]

/// What the provider, or the person serving a notice, told us afterwards.
/// One per attempt - a notice posted on the door AND mailed has two, which is
/// exactly the shape R-051 built `NoticeDelivery` to hold.
export interface CommsDelivery {
  /// A `DeliveryStatus` value, or a `NoticeServiceMethod` for a served
  /// notice. Kept as a string rather than a union of two enums because this
  /// is a reading model - narrowing it would buy nothing and would couple the
  /// transcript to both enums at once.
  status: string
  /// Why, where the status needs it: a suppression reason or a provider
  /// failure code.
  detail?: string | null
  sentAt?: Date | null
  deliveredAt?: Date | null
  readAt?: Date | null
  failedAt?: Date | null
  /// Provider message id (Twilio SID, Resend id) or a certified-mail article
  /// number. The number somebody quotes when they go and check.
  externalId?: string | null
}

export interface CommsEntry {
  kind: CommsEntryKind
  id: string
  /// When the communication happened - `Message.sentAt`, `Notification`'s
  /// creation, `Notice.generatedAt`. NOT when we recorded it.
  occurredAt: Date
  /// `PORTAL`/`SMS`/`EMAIL`/`CALL_LOG`, or a notice's service method.
  channel: string
  direction: 'INBOUND' | 'OUTBOUND'
  /// The parties, as text rather than foreign keys, and for the same reason
  /// `Notification.toAddress` is text (see its own comment): "we emailed
  /// jane@example.com on the 3rd" survives a tenant record being renamed,
  /// merged or deactivated, which is stronger evidence than a pointer to a
  /// row whose contents have since changed.
  from: string
  to: string
  subject?: string | null
  body: string
  deliveries: readonly CommsDelivery[]
}

/**
 * Every communication, in the order it happened.
 *
 * SORTED HERE, not trusted from the caller - the same call `statement()`
 * makes in the ledger, and for the same reason: the entire value of the
 * document is that it reads in the order things occurred, and a caller that
 * forgot would produce a transcript that is plausible and wrong.
 *
 * Ties break on kind then id, so a notice generated in the same instant as
 * the notification announcing it always renders in the same order. Two
 * exports of an unchanged history must be byte-identical, or "is this the
 * transcript you gave me in March" stops being answerable.
 */
export function mergeCommsEntries(
  ...groups: readonly (readonly CommsEntry[])[]
): CommsEntry[] {
  return groups
    .flat()
    .sort(
      (a, b) =>
        a.occurredAt.getTime() - b.occurredAt.getTime() ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    )
}

/// Plain English for a suppression reason. COMM-05's transcript is read by an
/// adjuster or a judge, and `no_consent` on a page is a cryptic code of
/// exactly the sort PAY-09 forbids two epics away.
const SUPPRESSION_NARRATIVE: Record<SuppressionReason, string> = {
  preference_off: 'not sent — the recipient had turned off this kind of message',
  no_address: 'not sent — no address of that kind was on file',
  kill_switch: 'not sent — sending was disabled system-wide at the time',
  unsupported_channel: 'not sent — this kind of message cannot go by that channel',
  sms_opt_out: 'not sent — the carrier reported this number had replied STOP',
  no_consent: 'not sent — no consent to text this person was on file',
}

const STATUS_NARRATIVE: Record<string, string> = {
  QUEUED: 'queued, with no delivery confirmation recorded',
  SENT: 'accepted by the provider',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
  BOUNCED: 'bounced',
  DEFERRED: 'held for quiet hours and sent later',
}

/**
 * One delivery attempt, in a sentence.
 *
 * ==========================================================================
 * "ACCEPTED BY THE PROVIDER" IS NOT "DELIVERED", AND THIS SAYS SO.
 *
 * `SENT` in this system has always meant the provider took the message, not
 * that it arrived - `delivery-status.ts` was written at R-040e around exactly
 * that distinction. A transcript that printed "Sent" for both would let a
 * landlord tell a court a notice was delivered when all that is recorded is
 * that Twilio accepted it, and the transcript's own authority is what would
 * make the overstatement persuasive.
 *
 * So the wording of every status here is deliberately no stronger than the
 * evidence behind it, and `timestamps` are passed in already formatted in the
 * PROPERTY's timezone (D-3) rather than being formatted here, because core
 * must not guess a zone.
 * ==========================================================================
 */
export function deliveryNarrative(
  delivery: CommsDelivery,
  format: (instant: Date) => string,
): string {
  if (delivery.status === 'SUPPRESSED') {
    const reason = delivery.detail as SuppressionReason | null | undefined
    const known = reason ? SUPPRESSION_NARRATIVE[reason] : undefined
    // An unrecognised reason prints the raw token rather than a friendly
    // guess: a suppression reason added later and not added here must look
    // unfinished, not look explained.
    return known ?? `not sent — ${reason ?? 'reason not recorded'}`
  }

  const parts: string[] = [STATUS_NARRATIVE[delivery.status] ?? delivery.status]

  // Every timestamp we hold, not just the newest. A message delivered at 09:14
  // and read at 16:02 is a different fact from one read the moment it landed,
  // and which of those it was is regularly the point in dispute.
  if (delivery.sentAt) parts.push(`sent ${format(delivery.sentAt)}`)
  if (delivery.deliveredAt) parts.push(`delivered ${format(delivery.deliveredAt)}`)
  if (delivery.readAt) parts.push(`read ${format(delivery.readAt)}`)
  if (delivery.failedAt) parts.push(`failed ${format(delivery.failedAt)}`)
  if (delivery.status === 'FAILED' && delivery.detail) {
    parts.push(`provider reason ${delivery.detail}`)
  }
  if (delivery.externalId) parts.push(`provider reference ${delivery.externalId}`)

  return parts.join('; ')
}

/**
 * What a reader must be told about gaps in this record.
 *
 * An OUTBOUND entry with no delivery row at all is not the same as one that
 * failed, and neither is the same as one that arrived. A transcript that left
 * all three looking alike would be the misleading document this whole item
 * exists to avoid, so the caller renders this line explicitly.
 */
export function hasNoDeliveryRecord(entry: CommsEntry): boolean {
  return entry.direction === 'OUTBOUND' && entry.deliveries.length === 0
}
