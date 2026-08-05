import 'server-only'

import type { EventEnvelope } from '@rental/core/events'
import { type Prisma, prisma } from '@rental/db'

// The transactional outbox.
//
// `emitEvent` takes the transaction the change runs in, exactly as
// `recordAudit` does and for the same reason: an event written after commit is
// lost whenever the process dies in the gap, and lost silently. Written inside
// the transaction, the event and the fact it announces cannot disagree.
//
//   await prisma.$transaction(async (tx) => {
//     await tx.lease.update({ where: { id }, data: { status: 'ENDED' } })
//     await emitEvent(tx, { type: 'lease.ended', aggregateType: 'Lease', ... })
//   })
//
// Delivery is at-least-once. Exactly-once delivery does not exist; what does
// exist is at-least-once delivery plus idempotent consumers, which is what
// EventConsumption provides.

export type OutboxDb = Prisma.TransactionClient | typeof prisma

export async function emitEvent(
  db: OutboxDb,
  event: EventEnvelope,
): Promise<void> {
  await db.outboxEvent.create({
    data: {
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      propertyId: event.propertyId ?? null,
      payload: (event.payload ?? {}) as Prisma.InputJsonValue,
      occurredAt: event.occurredAt ?? new Date(),
    },
  })
}

/// A consumer is a named function that reacts to one event type. The name is
/// the idempotency key, so renaming one makes it re-consume everything it has
/// already handled.
export interface Consumer {
  name: string
  event: EventEnvelope['type']
  handle: (
    tx: Prisma.TransactionClient,
    event: {
      id: string
      aggregateType: string
      aggregateId: string
      propertyId: string | null
      payload: Prisma.JsonValue
      occurredAt: Date
    },
  ) => Promise<void>
}

/**
 * The registry. Empty on purpose: R-006 builds the bus, and the items that own
 * the reactions register their own consumers here - R-011 for task creation,
 * R-030 for notifications, R-034 for the ledger projection.
 *
 * An empty registry is a working bus, not a broken one: events still
 * accumulate and are marked published, so nothing is lost while the consumers
 * that care are still being built.
 */
export const CONSUMERS: Consumer[] = []

export interface DispatchResult {
  published: number
  failed: number
}

const MAX_ATTEMPTS = 5

/**
 * Publishes unpublished events to every consumer subscribed to their type.
 *
 * Each (event, consumer) pair runs in its OWN transaction alongside the
 * EventConsumption row that records it. That is what makes a consumer
 * idempotent: either its effects and its consumption row both commit, or
 * neither does and the pair is retried. A consumer that half-succeeded is
 * retried rather than skipped.
 *
 * One failing consumer does not block the others, and does not block the
 * event being marked published once its siblings have had their turn -
 * otherwise a single permanently-broken consumer would stall the whole bus.
 *
 * ponytail: polled from the hourly cron, oldest first, batched. That is a
 * latency floor of one hour for anything that only the bus drives, which is
 * fine for nightly work and NOT fine for an emergency maintenance page - R-029
 * routes those directly rather than through this. Move to a queue with a
 * push trigger if sub-hour latency is ever needed generally.
 */
export async function dispatchOutbox(batchSize = 100): Promise<DispatchResult> {
  const pending = await prisma.outboxEvent.findMany({
    where: { publishedAt: null, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { occurredAt: 'asc' },
    take: batchSize,
  })

  let published = 0
  let failed = 0

  for (const event of pending) {
    const consumers = CONSUMERS.filter((c) => c.event === event.type)
    let allSucceeded = true

    for (const consumer of consumers) {
      try {
        await prisma.$transaction(async (tx) => {
          // Claim first. If this insert conflicts, another dispatcher already
          // handled the pair and the handler must not run again.
          await tx.eventConsumption.create({
            data: { eventId: event.id, consumer: consumer.name },
          })
          await consumer.handle(tx, {
            id: event.id,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            propertyId: event.propertyId,
            payload: event.payload,
            occurredAt: event.occurredAt,
          })
        })
      } catch (error) {
        if (isAlreadyConsumed(error)) continue
        allSucceeded = false
        console.error(
          `[outbox] consumer ${consumer.name} failed on ${event.type} ${event.id}`,
          error,
        )
      }
    }

    // updateMany, not update: the row can legitimately be gone by now (a
    // caller that deletes its own OutboxEvent rows once it no longer cares,
    // same as R-020's and R-021's e2e cleanup does) - update() throws P2025
    // for that, which would abort the whole batch over one already-moot row.
    // updateMany() just reports zero rows touched, which is correct: nothing
    // left to mark.
    if (allSucceeded) {
      await prisma.outboxEvent.updateMany({
        where: { id: event.id },
        data: { publishedAt: new Date(), attempts: { increment: 1 } },
      })
      published++
    } else {
      // Left unpublished so the failed consumers are retried, up to
      // MAX_ATTEMPTS. Consumers that already succeeded are protected from a
      // second run by their EventConsumption row.
      await prisma.outboxEvent.updateMany({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          lastError: `one or more consumers failed for ${event.type}`,
        },
      })
      failed++
    }
  }

  return { published, failed }
}

/// Prisma's unique-constraint code. A conflict here is the idempotency
/// mechanism working, not an error.
function isAlreadyConsumed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  )
}

/// Events that exhausted their retries. Nothing consumes this yet; it is the
/// query a dead-letter view would run, and R-007's shell is where it belongs.
export async function deadLetteredEvents(limit = 50) {
  return prisma.outboxEvent.findMany({
    where: { publishedAt: null, attempts: { gte: MAX_ATTEMPTS } },
    orderBy: { occurredAt: 'asc' },
    take: limit,
  })
}
