import 'server-only'

import { randomBytes } from 'node:crypto'
import {
  type OutboundChannel,
  type UnroutedReason,
  REPLY_KEY_LENGTH,
  decideRoute,
  extractReplyKey,
  normalizePhone,
  replyAddress,
} from '@rental/core/comms'
import type { MessageChannel } from '@rental/db'
import { type Prisma, prisma } from '@rental/db'
import { deliverOverChannel } from '@/lib/notifications/deliver.ts'
import { candidatesForEmail, candidatesForPhone, resolveThread } from './threads.ts'
import { inboundEmailConfig } from './inbound-email-config.ts'

// Writing to a thread (COMM-01, R-017).
//
// Message is append-only at the database level, alongside LedgerEntry,
// AuditLog and Notification. Everything here therefore writes once and never
// edits: a correction is a new message, and delivery status lives on the
// separate MessageDelivery row a provider callback is free to move.

type Db = Prisma.TransactionClient | typeof prisma

/**
 * The Reply-To for a thread's outbound email, minting the key if this is the
 * first one (COMM-08, R-097a).
 *
 * Returns undefined where no inbound domain is configured, which is a
 * supported state: replies then arrive wherever the provider forwards them
 * and route by From: address, R-017's ordinary path. What is lost is thread
 * precision, not the feature.
 */
async function replyAddressForThread(threadId: string): Promise<string | undefined> {
  const inbound = inboundEmailConfig()
  if (!inbound) return undefined

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { replyKey: true },
  })
  if (!thread) return undefined

  let key = thread.replyKey
  if (!key) {
    // Lower-case alphanumeric only: it goes into an address, and mail
    // systems are free to change the case of a local part in transit.
    key = randomBytes(16).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, REPLY_KEY_LENGTH)
    await prisma.thread.update({ where: { id: threadId }, data: { replyKey: key } })
  }
  return replyAddress({
    inboundLocalPart: inbound.localPart,
    inboundDomain: inbound.domain,
    replyKey: key,
  })
}

/// Written in the same transaction as the message, so a thread can never
/// claim a last-message time that no message backs up.
async function touchThread(db: Db, threadId: string, at: Date) {
  await db.thread.update({
    where: { id: threadId },
    data: { lastMessageAt: at },
  })
}

/**
 * A staff member's outbound message in a thread.
 *
 * Written to the log FIRST, then delivered. A provider that accepts a message
 * we failed to record is a message the tenant has and we cannot prove we
 * sent; the reverse - recorded, delivery failed, failure recorded on the
 * delivery row - is recoverable and visible. Evidence before transmission,
 * every time.
 *
 * Not routed through R-016's `notify()`: that is the automated-notification
 * path, with templates, per-category preferences and quiet-hours deferral,
 * none of which apply to a human answering a question inside a conversation.
 * It does go through the same `deliverOverChannel`, so the kill switch and
 * the sandbox redirect cover it exactly as they cover a notification -
 * nothing here opens a provider client itself.
 */
export async function sendThreadMessage(args: {
  threadId: string
  channel: OutboundChannel
  body: string
  staffUserId: string
  /// Where it is actually going - the tenant's phone or email. PORTAL
  /// messages have no external address; they are read in the portal (R-018)
  /// off this same log.
  toAddress: string | null
  sentAt?: Date
  /// R-032: which incident this reply is ABOUT, when it is known - a staff
  /// member replying from a work order's own page knows exactly which job,
  /// and stamping it here is what lets that reply appear on the work
  /// order's merged timeline without a second lookup. Absent for an
  /// ordinary reply from the plain messages inbox, which is not about any
  /// one job.
  ticketId?: string | null
  workOrderId?: string | null
}) {
  const sentAt = args.sentAt ?? new Date()

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        threadId: args.threadId,
        channel: args.channel,
        direction: 'OUTBOUND',
        body: args.body,
        sentAt,
        staffUserId: args.staffUserId,
        ticketId: args.ticketId ?? null,
        workOrderId: args.workOrderId ?? null,
        delivery: { create: { status: 'QUEUED' } },
      },
    })
    await touchThread(tx, args.threadId, sentAt)
    return created
  })

  if (args.channel === 'PORTAL' || !args.toAddress) {
    // Nothing to transmit: the portal message IS delivered by existing.
    await prisma.messageDelivery.updateMany({
      where: { messageId: message.id },
      data: { status: 'DELIVERED', deliveredAt: sentAt },
    })
    return message
  }

  // R-097a. The reply key is minted HERE, on the first outbound email in a
  // thread, rather than when the thread is created - a portfolio that never
  // emails never grows one, and a thread that only ever carried SMS has
  // nothing to leak.
  const replyTo =
    args.channel === 'EMAIL' ? await replyAddressForThread(args.threadId) : undefined

  const outcome = await deliverOverChannel({
    channel: args.channel,
    to: args.toAddress,
    body: args.body,
    replyTo,
  })

  await prisma.messageDelivery.updateMany({
    where: { messageId: message.id },
    data:
      outcome.status === 'SENT'
        ? { status: 'SENT', externalId: outcome.externalId ?? null }
        : outcome.status === 'FAILED'
          ? {
              status: 'FAILED',
              failedAt: new Date(),
              failureCode: outcome.failureCode ?? 'unknown',
            }
          : // SUPPRESSED, not QUEUED: the kill switch is on, or the adapter
            // has no provider for this channel. Nothing is going to pick it
            // up later, and a row sitting QUEUED forever reads as "still
            // trying" to anyone looking at the thread.
            {
              status: 'SUPPRESSED',
              failureCode: outcome.suppressedReason ?? null,
            },
  })

  return message
}

/**
 * A phone call, written up afterwards (COMM-01: "contemporaneous notes carry
 * legal weight").
 *
 * `occurredAt` is when the call happened, which is not when the note was
 * typed - `createdAt` records that separately, and the pair is what makes the
 * note contemporaneous rather than reconstructed. Both are on the row because
 * a transcript that showed only one of them would be answering the wrong
 * question in a dispute.
 */
export async function logCall(args: {
  threadId: string
  body: string
  staffUserId: string
  occurredAt: Date
}) {
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        threadId: args.threadId,
        channel: 'CALL_LOG',
        // A logged call is a record of a conversation, not a transmission -
        // but direction is required, and OUTBOUND is what "staff placed or
        // handled this call" reads as in a transcript.
        direction: 'OUTBOUND',
        body: args.body,
        sentAt: args.occurredAt,
        staffUserId: args.staffUserId,
      },
    })
    // Only if this call is the newest thing in the thread - writing up a call
    // from last Tuesday must not jump the thread to the top of the inbox.
    const thread = await tx.thread.findUniqueOrThrow({
      where: { id: args.threadId },
      select: { lastMessageAt: true },
    })
    if (!thread.lastMessageAt || thread.lastMessageAt < args.occurredAt) {
      await touchThread(tx, args.threadId, args.occurredAt)
    }
    return message
  })
}

/**
 * A vendor's own message, posted from their magic-link page (COMM-06,
 * R-032).
 *
 * PORTAL ONLY, and no `toAddress` - unlike `sendThreadMessage`, there is
 * nothing to transmit. The vendor is already looking at the page; this is a
 * write to the log that IS the delivery, the same reasoning
 * `sendThreadMessage` uses for a staff member's own PORTAL replies.
 *
 * The caller already knows exactly which vendor and which work order -
 * `verifyVendorLink()` established that before this is ever called - so
 * both are stamped directly rather than inferred.
 */
export async function postVendorPortalMessage(args: {
  threadId: string
  vendorId: string
  workOrderId: string
  body: string
  sentAt?: Date
}) {
  const sentAt = args.sentAt ?? new Date()
  return prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        threadId: args.threadId,
        channel: 'PORTAL',
        direction: 'INBOUND',
        body: args.body,
        sentAt,
        vendorId: args.vendorId,
        workOrderId: args.workOrderId,
        // Inbound is delivered by definition - it arrived.
        delivery: { create: { status: 'DELIVERED', deliveredAt: sentAt } },
      },
    })
    await touchThread(tx, args.threadId, sentAt)
    return created
  })
}

export type InboundResult =
  | { outcome: 'routed'; threadId: string; messageId: string }
  | { outcome: 'unrouted'; reason: UnroutedReason; unroutedId: string }
  | { outcome: 'duplicate' }

/**
 * An inbound message from a provider webhook.
 *
 * The safety-critical path in this item. `decideRoute` refuses to guess when
 * the sender matches zero or several parties, and this refuses along with it:
 * the message is recorded as unrouted for a human to file rather than
 * dropped, and never filed on a maybe. See packages/core/comms/threads.ts for
 * why the tie-break falls that way.
 *
 * Provider-agnostic on purpose. There is no Twilio webhook route yet - D-15's
 * 10DLC registration has to clear first, and R-021 owns turning an inbound
 * text into a ticket - so this is the function that route will call, tested
 * without one.
 */
export async function receiveInboundMessage(args: {
  channel: MessageChannel
  from: string
  body: string
  receivedAt: Date
  /// Provider message id. Providers retry webhooks; this is what makes a
  /// redelivery a no-op rather than a second copy in somebody's history.
  externalId?: string | null
  /// R-097a: every recipient header on an inbound email - To, Cc, and
  /// whatever the provider calls the envelope recipient. Read only to find
  /// our own plus-addressed reply key; a reply that CC'd the office and To'd
  /// a colleague still carries it somewhere, and taking only `To:` would
  /// drop it.
  recipients?: readonly string[]
}): Promise<InboundResult> {
  if (args.externalId) {
    const [seenMessage, seenUnrouted] = await Promise.all([
      prisma.message.findFirst({
        where: { externalId: args.externalId },
        select: { id: true, threadId: true },
      }),
      prisma.unroutedMessage.findUnique({
        where: { externalId: args.externalId },
        select: { id: true },
      }),
    ])
    if (seenMessage || seenUnrouted) return { outcome: 'duplicate' }
  }

  // R-097a. THE REPLY KEY FIRST, AND IT SHORT-CIRCUITS EVERYTHING BELOW.
  // It names the thread outright, which is the one thing candidate matching
  // cannot do: a tenant with tenancies at two properties replying about one
  // of them is `decideRoute`'s AMBIGUOUS case, and the key says which. It is
  // only ever trusted to pick between conversations that already exist -
  // never to create one, and never to say who somebody is.
  const inbound = inboundEmailConfig()
  if (args.channel === 'EMAIL' && inbound && args.recipients && args.recipients.length > 0) {
    const key = extractReplyKey({
      recipients: args.recipients,
      inboundLocalPart: inbound.localPart,
      inboundDomain: inbound.domain,
    })
    if (key) {
      const thread = await prisma.thread.findUnique({
        where: { replyKey: key },
        select: { id: true, tenantId: true, vendorId: true },
      })
      // A key naming no thread falls through rather than failing. A deleted
      // conversation, a forwarded old email, a mangled tag: all of them
      // should still get the message filed by From: address if they can be.
      if (thread) {
        const message = await prisma.$transaction(async (tx) => {
          const created = await tx.message.create({
            data: {
              threadId: thread.id,
              channel: args.channel,
              direction: 'INBOUND',
              body: args.body,
              sentAt: args.receivedAt,
              tenantId: thread.tenantId,
              vendorId: thread.vendorId,
              externalId: args.externalId ?? null,
              delivery: { create: { status: 'DELIVERED', deliveredAt: args.receivedAt } },
            },
          })
          await touchThread(tx, thread.id, args.receivedAt)
          return created
        })
        return { outcome: 'routed', threadId: thread.id, messageId: message.id }
      }
    }
  }

  const e164 = args.channel === 'EMAIL' ? null : normalizePhone(args.from)
  const candidates =
    args.channel === 'EMAIL'
      ? await candidatesForEmail(args.from)
      : e164
        ? await candidatesForPhone(e164)
        : []
  const decision = decideRoute(candidates)

  if (decision.outcome === 'unrouted') {
    const unrouted = await prisma.unroutedMessage.create({
      data: {
        channel: args.channel,
        // Stored normalized where possible, as received where not - an
        // unparseable number is still evidence of who tried to make contact.
        fromAddress: e164 ?? args.from,
        body: args.body,
        reason: decision.reason,
        externalId: args.externalId ?? null,
        receivedAt: args.receivedAt,
      },
    })
    return {
      outcome: 'unrouted',
      reason: decision.reason,
      unroutedId: unrouted.id,
    }
  }

  const { candidate } = decision
  const thread = await resolveThread({
    scope: candidate.scope,
    propertyId: candidate.propertyId,
    tenantId: candidate.scope === 'TENANT' ? candidate.partyId : null,
    vendorId: candidate.scope === 'VENDOR' ? candidate.partyId : null,
  })

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        threadId: thread.id,
        channel: args.channel,
        direction: 'INBOUND',
        body: args.body,
        sentAt: args.receivedAt,
        tenantId: candidate.scope === 'TENANT' ? candidate.partyId : null,
        vendorId: candidate.scope === 'VENDOR' ? candidate.partyId : null,
        externalId: args.externalId ?? null,
        // Inbound is delivered by definition - it arrived.
        delivery: { create: { status: 'DELIVERED', deliveredAt: args.receivedAt } },
      },
    })
    await touchThread(tx, thread.id, args.receivedAt)
    return created
  })

  return { outcome: 'routed', threadId: thread.id, messageId: message.id }
}

/**
 * A human files an unrouted message into a thread.
 *
 * The original `receivedAt` becomes the message's `sentAt`, so the transcript
 * reads in the order things actually happened rather than the order somebody
 * got around to sorting them out - which is the whole point of a timestamped
 * evidence trail.
 */
export async function routeUnroutedMessage(args: {
  unroutedId: string
  threadId: string
  staffUserId: string
}) {
  const unrouted = await prisma.unroutedMessage.findUniqueOrThrow({
    where: { id: args.unroutedId },
  })
  if (unrouted.routedMessageId) {
    // Already filed by somebody else. Not an error - two people opening the
    // same triage item is ordinary - but it must not file twice.
    return null
  }

  const thread = await prisma.thread.findUniqueOrThrow({
    where: { id: args.threadId },
    select: { id: true, tenantId: true, vendorId: true },
  })

  return prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        threadId: thread.id,
        channel: unrouted.channel,
        direction: 'INBOUND',
        body: unrouted.body,
        sentAt: unrouted.receivedAt,
        tenantId: thread.tenantId,
        vendorId: thread.vendorId,
        externalId: unrouted.externalId,
        delivery: {
          create: { status: 'DELIVERED', deliveredAt: unrouted.receivedAt },
        },
      },
    })
    // updateMany + a routedMessageId check, not update: two people filing the
    // same item at once must produce one message, and the loser no-ops
    // instead of throwing (the same double-submission fix R-012 needed).
    const claimed = await tx.unroutedMessage.updateMany({
      where: { id: args.unroutedId, routedMessageId: null },
      data: {
        routedMessageId: message.id,
        routedAt: new Date(),
        routedByStaffId: args.staffUserId,
      },
    })
    if (claimed.count === 0) {
      throw new Error('ALREADY_ROUTED')
    }
    const existing = await tx.thread.findUniqueOrThrow({
      where: { id: thread.id },
      select: { lastMessageAt: true },
    })
    if (!existing.lastMessageAt || existing.lastMessageAt < unrouted.receivedAt) {
      await touchThread(tx, thread.id, unrouted.receivedAt)
    }
    return message
  })
}
