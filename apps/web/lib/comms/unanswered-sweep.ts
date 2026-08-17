import 'server-only'

import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { createTask } from '@/lib/tasks/create.ts'

// "Unanswered tenant messages past X days surface on the dashboard" (COMM-07,
// R-054).
//
// Hourly, alongside the other elapsed-time sweeps (vendors/no-response.ts,
// workorders/entry-reminders.ts) rather than a SCHEDULED_JOBS entry - this
// measures days since the last INBOUND message, the same duration in every
// timezone, not a property-local calendar question.
//
// ponytail: a flat day count, not a per-property configurable threshold.
// COMM-07 says "past X days" without saying who sets X, and every SLA-shaped
// number already in this codebase (packages/core/maintenance/sla.ts's 4
// hours) started the same way - a constant with its own upgrade path named
// here rather than a settings row and a migration for one number nobody has
// asked to change yet. Upgrade path: a per-property column the moment an
// owner wants a different threshold than another owner.
const UNANSWERED_THRESHOLD_DAYS = 2

export interface UnansweredSweepResult {
  checked: number
  flagged: number
}

/**
 * Raises a Task for every tenant thread whose newest message is INBOUND and
 * older than the threshold - a tenant who wrote and nobody has answered
 * since.
 *
 * A thread's `lastMessageAt` is only stale (COMM-01: it moves with every
 * message, inbound or outbound) if nothing has happened since - so a
 * candidate list on that column already excludes any thread staff answered
 * more recently than the threshold. What it does NOT exclude is a thread
 * that went quiet because STAFF sent the last word and the tenant simply
 * has nothing to say back; the per-thread check below is what tells the two
 * apart.
 */
export async function sweepUnansweredTenantMessages(
  now = new Date(),
  /**
   * Narrows the sweep to specific threads - what a test passes, so it never
   * pays for (or is slowed by) every stale tenant thread that has
   * accumulated in the shared test database. `Message` and `Thread` cannot
   * be deleted in cleanup (Message is append-only), so an unfiltered sweep
   * run from a test only grows slower over time - the same trap CLAUDE.md
   * names for a global sweep in a test.
   */
  only?: { threadIds: readonly string[] },
): Promise<UnansweredSweepResult> {
  if (only && only.threadIds.length === 0) return { checked: 0, flagged: 0 }

  const cutoff = new Date(now.getTime() - UNANSWERED_THRESHOLD_DAYS * 24 * 60 * 60 * 1000)

  const candidates = await prisma.thread.findMany({
    where: {
      tenantId: { not: null },
      lastMessageAt: { lte: cutoff },
      ...(only ? { id: { in: [...only.threadIds] } } : {}),
    },
    select: {
      id: true,
      propertyId: true,
      tenantId: true,
      lastMessageAt: true,
      property: { select: { timezone: true } },
      tenant: { select: { firstName: true, lastName: true } },
    },
  })

  let flagged = 0
  for (const thread of candidates) {
    const last = await prisma.message.findFirst({
      where: { threadId: thread.id },
      orderBy: { sentAt: 'desc' },
      select: { direction: true },
    })
    // Staff had the last word, or a thread with no messages at all (created
    // but never sent into) - neither is "unanswered".
    if (last?.direction !== 'INBOUND') continue

    const tenantName = thread.tenant
      ? `${thread.tenant.firstName} ${thread.tenant.lastName}`
      : 'a tenant'
    // `lastMessageAt` cannot actually be null here - the query filtered on
    // it - but the column is nullable in the schema, so the fallback keeps
    // this honest about that rather than asserting it away.
    const lastMessageAt = thread.lastMessageAt ?? cutoff
    const days = Math.floor((now.getTime() - lastMessageAt.getTime()) / (24 * 60 * 60 * 1000))

    const { created } = await createTask(prisma, {
      propertyId: thread.propertyId,
      type: 'tenant_unanswered',
      subjectType: 'Thread',
      subjectId: thread.id,
      businessDate: businessDate(now, thread.property.timezone),
      priority: 'ROUTINE',
      title: `No reply to ${tenantName} in ${days}d`,
    })
    if (created) flagged += 1
  }

  return { checked: candidates.length, flagged }
}
