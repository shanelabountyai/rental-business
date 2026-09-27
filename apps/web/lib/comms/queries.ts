import 'server-only'

import { type Actor, propertyScope } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for the inbox and a thread transcript (COMM-01, R-017). Every list is
// scoped through `Thread.propertyId` - which is exactly why the property is
// part of a thread's key rather than being allowed to drift when a tenant
// moves (see packages/core/comms/threads.ts).

/**
 * The inbox: threads the actor can see, most recently active first.
 *
 * `lastMessageAt` is the denormalized column rather than a computed max,
 * because Prisma can order by a relation's COUNT but not by a related row's
 * greatest timestamp - see Thread.lastMessageAt's own comment.
 */
export async function listThreads(scope: ResolvedScope, limit = 100) {
  if (scope.propertyIds.length === 0) return []

  return prisma.thread.findMany({
    where: { propertyId: { in: scope.propertyIds } },
    include: {
      // `timezone` because the inbox stamps each row's latest message, and
      // it used to do it in UTC while the thread page next door rendered the
      // SAME message property-local - opening a conversation changed the time
      // on it (R-115).
      property: { select: { id: true, name: true, timezone: true } },
      tenant: { select: { id: true, firstName: true, lastName: true } },
      vendor: { select: { id: true, name: true } },
      messages: {
        orderBy: { sentAt: 'desc' },
        take: 1,
        select: { body: true, channel: true, direction: true, sentAt: true },
      },
    },
    orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  })
}

/**
 * One thread with its full transcript, or null when it is outside the
 * actor's scope.
 *
 * Null rather than a thrown error, so the page can render a 404 - a thread
 * the actor may not see must not be distinguishable from one that does not
 * exist, or the response itself confirms that a given tenant has a
 * conversation at a property they were told nothing about.
 */
export async function getThread(threadId: string, scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return null

  return prisma.thread.findFirst({
    where: { id: threadId, propertyId: { in: scope.propertyIds } },
    include: {
      // legalEntityId too, not just id and name: an `actorCan` check needs
      // BOTH ids to match an entity-scoped grant, and passing a placeholder
      // for the entity is how R-008 wrongly hid its own Edit button.
      property: {
        select: { id: true, name: true, legalEntityId: true, timezone: true },
      },
      tenant: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
      vendor: { select: { id: true, name: true, email: true, phone: true } },
      messages: {
        orderBy: { sentAt: 'asc' },
        include: {
          staffUser: { select: { id: true, name: true } },
          delivery: true,
          // R-097d: what arrived attached. Stored and then never shown is
          // only half of not losing it.
          documents: {
            where: { deletedAt: null },
            select: { id: true, fileName: true, contentType: true, sizeBytes: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  })
}

/**
 * Inbound messages waiting for a human to file them.
 *
 * Deliberately NOT scoped: an unrouted message has no property by definition
 * - that is why it is unrouted - so there is nothing to scope it against.
 * The page guards on `message.send`, which is the permission that lets
 * somebody file one, rather than pretending a scope check happened.
 */
/**
 * SEC-16 / D-266: only PORTFOLIO-WIDE staff triage the unrouted inbox. An
 * unrouted message has no property, so no property or entity grant can
 * authorize reading it - a stranger's text stays with whoever holds
 * `message.read` over the whole portfolio (a null-scope assignment,
 * `propertyScope(...).everything`). Filing also needs `message.send` at the
 * same level. The one gate for the page, its badge, both reads and the action.
 */
export function triagesUnrouted(actor: Actor, filing = false): boolean {
  const needed = filing ? (['message.read', 'message.send'] as const) : (['message.read'] as const)
  return needed.every((permission) => propertyScope(actor, permission).everything)
}

export async function listUnroutedMessages(actor: Actor, limit = 50) {
  if (!triagesUnrouted(actor)) return []
  return prisma.unroutedMessage.findMany({
    where: { routedAt: null },
    orderBy: { receivedAt: 'asc' },
    take: limit,
  })
}

export async function unroutedCount(actor: Actor): Promise<number> {
  if (!triagesUnrouted(actor)) return 0
  return prisma.unroutedMessage.count({ where: { routedAt: null } })
}
