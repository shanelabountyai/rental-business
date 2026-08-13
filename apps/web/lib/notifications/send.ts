import 'server-only'

import {
  type NotificationCategory,
  type NotificationChannel,
  type SuppressionReason,
  bypassesQuietHours,
  isLockedCategory,
  isNotificationCategory,
  quietHoursEndAfter,
  renderTemplate,
  resolveChannels,
  templateFor,
  withinQuietHours,
} from '@rental/core/notifications'
import {
  type NotificationRecipientType,
  type Prisma,
  prisma,
} from '@rental/db'
import { businessDate } from '@rental/core/scheduling'
import { isOptedOut } from '@/lib/comms/opt-out-store.ts'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { createTask } from '@/lib/tasks/create.ts'
import { notificationConfig } from './config.ts'
import { deliverOverChannel } from './deliver.ts'
import { notificationAdapter } from './provider.ts'

// The engine (NOTIF-01). Every module that wants to tell somebody something
// calls `notify()` and nothing else - no module opens a provider client, and
// no module decides on its own whether a channel is allowed or whether 3am is
// an acceptable hour.
//
// DECIDING AND SENDING ARE SEPARATE STEPS, and that separation is the whole
// design:
//
//   notify() decides and records, inside whatever transaction its caller is
//   already in. An outbox consumer's notification therefore commits or rolls
//   back with the consumer's own effects, which is what makes a retried
//   consumer idempotent rather than a source of duplicate texts.
//
//   dispatchPendingNotifications() sends, outside any transaction. Network
//   calls inside a database transaction hold a pooled connection open for the
//   length of a third party's outage, and a transaction that commits after a
//   provider accepted the message is a message sent twice on retry.
//
// The gap between them is bounded by the cron (hourly, D-3's tick) and closed
// immediately by callers that want it to be - a staff-initiated send calls
// both in the same request.

export interface NotificationRecipient {
  type: NotificationRecipientType
  id: string
  email?: string | null
  phone?: string | null
}

export interface NotifyInput {
  category: NotificationCategory
  templateKey: string
  recipient: NotificationRecipient
  /// Template variables. Typed at the template, checked by the caller - see
  /// packages/core/notifications/templates.ts.
  context: unknown
  /// Drives quiet hours, which are property-local (D-3). A notification with
  /// no property never defers.
  propertyId?: string | null
  /// The OutboxEvent that caused this, when one did.
  eventId?: string | null
  /**
   * The natural key of the thing being announced - "late-notice:<leaseId>:
   * 2026-08-03", not a UUID. The engine suffixes the channel.
   *
   * This is the hard invariant: two calls with the same key send once. It has
   * to be derivable from the FACT rather than from the attempt, or a retry
   * generates a fresh key and the guarantee is worth nothing.
   */
  idempotencyKey: string
  now?: Date
}

export interface ChannelOutcome {
  channel: NotificationChannel
  /// `recorded` - a new row was written. `duplicate` - this exact
  /// (key, channel) was already decided, and nothing was written.
  outcome: 'recorded' | 'duplicate'
  status?: 'QUEUED' | 'SUPPRESSED' | 'DEFERRED'
  reason?: SuppressionReason
  /// The delivery row just written, when one was. Exists so a caller that
  /// needs its OWN messages sent immediately can hand exactly those ids to
  /// `dispatchPendingNotifications()` instead of flushing the global queue -
  /// see that function's `only` parameter, and R-020's emergency page, which
  /// is the caller this was added for.
  deliveryId?: string
}

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Decides and records one logical notification across every channel it
 * belongs on. Sends nothing.
 *
 * A channel that is turned off, unsupported, or killed by the switch still
 * gets a row, marked SUPPRESSED with its reason. That is deliberate and is
 * most of the value of the table: "why didn't the tenant get the late notice"
 * is answerable, and answerable at the moment somebody asks rather than by
 * reasoning about what the preferences were three weeks ago.
 */
export async function notify(
  input: NotifyInput,
  db: Db = prisma,
): Promise<ChannelOutcome[]> {
  if (!isNotificationCategory(input.category)) {
    throw new Error(
      `"${input.category}" is not a notification category. The vocabulary is closed - see packages/core/notifications/categories.ts.`,
    )
  }
  const template = templateFor(input.templateKey)
  if (!template) {
    throw new Error(
      `No template registered under "${input.templateKey}" (category ${input.category}).`,
    )
  }
  if (template.category !== input.category) {
    // Not pedantry: the category drives the recipient's preferences and the
    // quiet-hours bypass, so a send whose category and template disagree is
    // asking one question and answering another.
    throw new Error(
      `Template "${input.templateKey}" is registered under category "${template.category}", not "${input.category}".`,
    )
  }

  const now = input.now ?? new Date()
  const config = notificationConfig()

  // Preferences are only meaningful for a channel we could actually reach
  // them on, so resolution runs over the addressable subset - but the LOOP
  // below walks every channel the template declares, so a channel with no
  // address still gets a row saying so. Filtering here and iterating the
  // filtered list was the original shape, and it silently dropped an
  // address-less channel whenever some OTHER channel was addressable: the
  // exact "notification the product promised and never recorded" failure the
  // suppressed-row design exists to make impossible.
  const addressable = template.channels.filter(
    (channel) => addressFor(channel, input.recipient) !== null,
  )

  const preferences = await db.notificationPreference.findMany({
    where: {
      recipientType: input.recipient.type,
      recipientId: input.recipient.id,
      category: input.category,
    },
    select: { category: true, channel: true, enabled: true },
  })

  const decisions = new Map(
    resolveChannels({
      category: input.category,
      candidates: addressable,
      preferences,
    }).map((decision) => [decision.channel, decision]),
  )

  // Quiet hours need the property's own timezone (D-3). Loaded once for the
  // whole fan-out rather than per channel.
  const timezone =
    input.propertyId && !bypassesQuietHours(input.category)
      ? (
          await db.property.findUnique({
            where: { id: input.propertyId },
            select: { timezone: true },
          })
        )?.timezone
      : undefined

  const deferUntil =
    timezone && withinQuietHours(now, timezone)
      ? quietHoursEndAfter(now, timezone)
      : null

  // Asked ONCE for the whole fan-out rather than per channel, and only when
  // an SMS is actually on the table (R-040e). A carrier block is a fact about
  // the number, so it outranks every preference - including the ones
  // LOCKED_CATEGORIES refuses to let a tenant set.
  const smsBlocked =
    template.channels.includes('SMS') && addressFor('SMS', input.recipient) !== null
      ? await isOptedOut(addressFor('SMS', input.recipient))
      : false

  const outcomes: ChannelOutcome[] = []

  for (const channel of template.channels) {
    const address = addressFor(channel, input.recipient)
    const decision = decisions.get(channel)

    const rendered = renderTemplate(input.templateKey, input.context, channel)

    let status: 'QUEUED' | 'SUPPRESSED' | 'DEFERRED' = 'QUEUED'
    let reason: SuppressionReason | undefined

    if (address === null) {
      status = 'SUPPRESSED'
      reason = 'no_address'
    } else if (channel === 'SMS' && smsBlocked) {
      // BEFORE the preference check, deliberately. A blocked number is not a
      // preference and must not be recorded as one: `preference_off` on an
      // entry notice would read as a tenant choice the product does not even
      // allow, and would hide the fact that we owe them a notice we could not
      // deliver (D-38).
      status = 'SUPPRESSED'
      reason = 'sms_opt_out'
    } else if (!decision?.send) {
      status = 'SUPPRESSED'
      reason = decision?.reason ?? 'preference_off'
    } else if (!config.enabled) {
      status = 'SUPPRESSED'
      reason = 'kill_switch'
    } else if (!notificationAdapter.supports(channel)) {
      status = 'SUPPRESSED'
      reason = 'unsupported_channel'
    } else if (deferUntil) {
      status = 'DEFERRED'
    }

    outcomes.push(
      await record(db, {
        input,
        channel,
        // Recorded rather than left blank when there is nothing to send to:
        // the column is the evidence of who this was for, and "(none on
        // file)" says that honestly where an empty string would read as a bug.
        toAddress: address ?? '(none on file)',
        subject: rendered.subject,
        body: rendered.body,
        status,
        reason,
        sendAfter: status === 'DEFERRED' ? deferUntil : null,
      }),
    )
  }

  // D-38: A LEGALLY REQUIRED NOTICE WE COULD NOT TEXT RAISES A TASK.
  //
  // The owner's decision was "both" - fall back to another channel AND put a
  // human on it. The fallback half was already true: `entry.notice` declares
  // SMS, EMAIL and PORTAL, so a blocked SMS still leaves two live channels.
  // This is the half that was missing, and it is the half that matters,
  // because email and portal prove receipt no better than SMS did.
  //
  // Only for LOCKED categories. A blocked marketing text is a tenant getting
  // what they asked for; a blocked entry notice is a legal obligation we owe
  // and could not meet on the channel most tenants actually read. Texas
  // permits written notice, so posting on the door is a real answer - which
  // is why this raises work for a person rather than logging a warning.
  if (smsBlocked && isLockedCategory(input.category) && input.propertyId) {
    await raiseBlockedNoticeTask({
      db,
      propertyId: input.propertyId,
      category: input.category,
      recipient: input.recipient,
      timezone,
      now,
      idempotencyKey: input.idempotencyKey,
    }).catch((error) => {
      // The notice went out on the other channels and those rows are already
      // written. A failure to raise the task must not lose them.
      console.error('[notifications] failed to raise a blocked-notice task', error)
    })
  }

  return outcomes
}

/**
 * The human half of D-38.
 *
 * Idempotent on (type, subjectId, businessDate) like every other task, so the
 * T-1 reminder for the same entry notice on the same day does not raise a
 * second one - `createTask` already owns that guarantee (R-011).
 */
async function raiseBlockedNoticeTask(args: {
  db: Db
  propertyId: string
  category: NotificationCategory
  recipient: NotificationRecipient
  timezone: string | undefined
  now: Date
  idempotencyKey: string
}): Promise<void> {
  // The property's own calendar day (D-3). Falling back to UTC rather than
  // failing: a task raised on the wrong side of midnight is still a task
  // somebody sees, and refusing to raise it because a timezone lookup was
  // skipped would be the worse trade.
  const zone =
    args.timezone ??
    (
      await args.db.property.findUnique({
        where: { id: args.propertyId },
        select: { timezone: true },
      })
    )?.timezone ??
    'UTC'

  await createTask(args.db, {
    propertyId: args.propertyId,
    type: 'serve_notice_offline',
    subjectType: 'Notification',
    // The idempotency key, not a fresh id: it is derived from the FACT being
    // announced, so two attempts to serve the same notice collapse onto one
    // task exactly as they collapse onto one notification.
    subjectId: args.idempotencyKey,
    businessDate: businessDate(args.now, zone),
    // URGENT, not EMERGENCY: EMERGENCY is reserved for life-safety in this
    // product's vocabulary, and a notice that needs serving today is not that.
    // It is also not ROUTINE - the alternative to somebody acting on it is
    // entering a home without having served notice.
    priority: 'URGENT',
    title: `Serve ${args.category.replace(/_/g, ' ')} another way - this tenant's phone is blocking our texts`,
  })
}

interface RecordInput {
  input: NotifyInput
  channel: NotificationChannel
  toAddress: string
  subject?: string
  body: string
  status: 'QUEUED' | 'SUPPRESSED' | 'DEFERRED'
  reason?: SuppressionReason
  sendAfter: Date | null
}

/**
 * Writes the immutable decision and its mutable delivery row together.
 *
 * Together, not in sequence: the Notification is append-only, so a row
 * written without its delivery could never have one added by a retry - the
 * unique idempotency key would refuse the second attempt and the first would
 * be permanently un-sendable. One insert of both, or neither.
 */
async function record(db: Db, args: RecordInput): Promise<ChannelOutcome> {
  const key = `${args.input.idempotencyKey}:${args.channel}`
  try {
    const created = await db.notification.create({
      data: {
        idempotencyKey: key,
        category: args.input.category,
        channel: args.channel,
        recipientType: args.input.recipient.type,
        recipientId: args.input.recipient.id,
        toAddress: args.toAddress,
        templateKey: args.input.templateKey,
        subject: args.subject ?? null,
        body: args.body,
        propertyId: args.input.propertyId ?? null,
        eventId: args.input.eventId ?? null,
        delivery: {
          create: {
            status: args.status,
            suppressedReason: args.reason ?? null,
            sendAfter: args.sendAfter,
          },
        },
      },
      include: { delivery: { select: { id: true } } },
    })
    return {
      channel: args.channel,
      outcome: 'recorded',
      status: args.status,
      reason: args.reason,
      deliveryId: created.delivery?.id,
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The invariant holding, not a failure. Some other call - a retried
      // outbox consumer, a double-submitted form, a re-run job - already
      // decided this exact notification.
      return { channel: args.channel, outcome: 'duplicate' }
    }
    throw error
  }
}

export interface DispatchResult {
  sent: number
  failed: number
  /**
   * How many were still due AFTER this sweep finished (R-102).
   *
   * The sweep takes at most `limit` rows, so a portfolio queueing more than
   * that between ticks falls permanently behind - and until this existed the
   * cron recorded only `sent` and `failed`, which look identical whether the
   * queue is empty or ten thousand deep. A notification engine whose premise
   * is that a delivery record must never be silently false should not be able
   * to hide a backlog either.
   *
   * Reported, not acted on. The drain is still one batch per tick: a loop
   * that keeps going until the queue is empty is the right answer only once
   * this number is persistently non-zero, and building it before then is
   * guessing at a shape the real backlog has not shown yet. This is the
   * instrument that says when.
   */
  remaining: number
}

/**
 * Sends everything that is due, and records what the provider said.
 *
 * Picks up two populations, which are the same problem seen twice:
 *
 *   QUEUED - decided and never sent. Ordinarily sent moments later by the
 *   caller; still here if the process died between the commit and the send,
 *   which is exactly the gap that separating the two steps opens.
 *
 *   DEFERRED whose sendAfter has passed - held for quiet hours (NOTIF-05) and
 *   now due.
 *
 * Never runs inside a transaction. See this file's header.
 */
export async function dispatchPendingNotifications(
  now = new Date(),
  limit = 100,
  /**
   * Narrows the sweep to specific deliveries - what a caller that needs its
   * OWN messages out immediately passes (R-020's emergency page, R-025's
   * vendor dispatch, R-026's bid requests).
   *
   * WITHOUT this, an inline caller pays for the entire global backlog and,
   * worse, may not send its own message at all: the sweep takes the oldest
   * `limit` rows in id order, so an emergency page queued a moment ago sits
   * behind up to 100 unrelated notifications while the tenant waits. R-020
   * asked for "the page goes now"; flushing everyone else's queue is neither
   * now nor the page. Found when an emergency submit started exceeding 30s
   * against a database holding a few hundred stale test notifications.
   *
   * The hourly cron passes nothing and still sweeps globally, which is
   * exactly what a cron is for.
   */
  only?: { deliveryIds: readonly string[] },
): Promise<DispatchResult> {
  const config = notificationConfig()
  if (!config.enabled) return { sent: 0, failed: 0, remaining: 0 }
  // An explicit empty set means "nothing of mine was queued" - every channel
  // suppressed, say - and must not fall through to a global sweep.
  if (only && only.deliveryIds.length === 0) return { sent: 0, failed: 0, remaining: 0 }

  const dueWhere = {
    ...(only ? { id: { in: [...only.deliveryIds] } } : {}),
    OR: [
      { status: 'QUEUED' as const },
      { status: 'DEFERRED' as const, sendAfter: { lte: now } },
    ],
  }

  const due = await prisma.notificationDelivery.findMany({
    where: dueWhere,
    orderBy: { id: 'asc' },
    take: limit,
    include: { notification: true },
  })

  let sent = 0
  let failed = 0

  for (const delivery of due) {
    // Claim before sending. Two concurrent dispatchers - an hourly cron
    // overlapping a staff action - would otherwise both see QUEUED and both
    // send. The updateMany's own count tells the loser to stop, without a
    // lock and without a read-then-write race.
    const claimed = await prisma.notificationDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status },
      data: { status: 'QUEUED', attempts: { increment: 1 } },
    })
    if (claimed.count === 0) continue

    const { notification } = delivery
    const outcome = await deliverOverChannel({
      channel: notification.channel as NotificationChannel,
      to: notification.toAddress,
      subject: notification.subject ?? undefined,
      body: notification.body,
    })

    if (outcome.status === 'SENT') {
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          externalId: outcome.externalId ?? null,
        },
      })
      sent++
    } else if (outcome.status === 'SUPPRESSED') {
      // The switch was flipped between the decision and the send, or the
      // adapter lost a channel. Recorded rather than retried forever.
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'SUPPRESSED',
          suppressedReason: outcome.suppressedReason ?? null,
        },
      })
    } else {
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'FAILED',
          failedAt: new Date(),
          failureCode: outcome.failureCode ?? 'unknown',
        },
      })
      failed++
    }
  }

  // Counted after the sweep, not before, so it answers the question a reader
  // of the audit row actually has: is there still a queue? A count taken up
  // front would include everything this call just sent.
  const remaining = await prisma.notificationDelivery.count({ where: dueWhere })

  return { sent, failed, remaining }
}

/// PORTAL has no external address: the "address" is the account itself, and
/// the notification IS the delivery - it is read in the portal (R-018) off
/// the same log this engine writes. Recording the recipient id keeps the
/// column meaningful rather than blank for a third of all rows.
function addressFor(
  channel: NotificationChannel,
  recipient: NotificationRecipient,
): string | null {
  if (channel === 'EMAIL') return recipient.email?.trim() || null
  if (channel === 'SMS') return recipient.phone?.trim() || null
  return recipient.id
}
