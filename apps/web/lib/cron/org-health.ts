import 'server-only'

import { prisma } from '@rental/db'
import { MAX_ATTEMPTS } from '@/lib/jobs/outbox.ts'

// R-303 (PRD 11 §5.5, D-354): the console's only view of an org's running.
// Counted HERE, by the org's own cron child and scoped to its org, so the
// platform never runs a query over an org's rows. Every value is a count, a
// boolean, a timestamp or a two-letter state: `JobRun.error` and `result` are
// free text that can name a tenant, and stay behind a support grant.

export type CronChild = 'daily' | 'notifications' | 'escalations'

const DAY_MS = 24 * 60 * 60_000

export async function orgHealthCounts(orgId: string, now: Date) {
  const [failedRuns7d, deadLetters, queuedNotifications, heldNotifications, activeOwners, activeMembers, properties] =
    await Promise.all([
      prisma.jobRun.count({ where: { orgId, status: 'FAILED', startedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } } }),
      prisma.outboxEvent.count({ where: { orgId, publishedAt: null, attempts: { gte: MAX_ATTEMPTS } } }),
      prisma.notificationDelivery.count({ where: { orgId, status: 'QUEUED' } }),
      // Held for quiet hours (NOTIF-05). A switched-off org's held queue is
      // its QUEUED count beside `notificationsEnabled`, which the console
      // reads off the org row.
      prisma.notificationDelivery.count({ where: { orgId, status: 'DEFERRED' } }),
      prisma.staffAssignment.count({
        where: {
          orgId,
          revokedAt: null,
          role: { key: 'owner' },
          staffUser: { active: true, orgMemberships: { some: { orgId, removedAt: null } } },
        },
      }),
      prisma.orgMembership.count({ where: { orgId, removedAt: null, staffUser: { active: true } } }),
      prisma.property.count({ where: { orgId, active: true } }),
    ])
  const states = await prisma.property.findMany({
    where: { orgId, active: true },
    select: { state: true },
    distinct: ['state'],
    orderBy: { state: 'asc' },
  })
  return {
    failedRuns7d,
    deadLetters,
    queuedNotifications,
    heldNotifications,
    activeOwners,
    activeMembers,
    properties,
    // `Property.state` is a plain string column, so only a two-letter code
    // leaves the org: anything else in it is not a state, and may be text.
    states: states.map((p) => p.state).filter((state) => /^[A-Z]{2}$/.test(state)),
  }
}

/**
 * Upserts the org's row with this child's outcome and fresh counts. Never
 * throws: the cron's own result is what Vercel needs to see, and a health
 * row that failed to write reads as "not reported since", which is true.
 */
export async function recordOrgHealth(orgId: string, child: CronChild, ok: boolean, now = new Date()) {
  try {
    const counts = await orgHealthCounts(orgId, now)
    const run = { [`${child}At`]: now, [`${child}Ok`]: ok }
    await prisma.orgHealth.upsert({
      where: { orgId },
      create: { orgId, computedAt: now, ...run, ...counts },
      update: { computedAt: now, ...run, ...counts },
    })
  } catch {
    // See above.
  }
}
