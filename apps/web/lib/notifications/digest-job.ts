import 'server-only'

import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { notify } from './send.ts'

// NOTIF-04's daily digest, the other half of send.ts's `digest_batched`
// branch: everything suppressed under that reason since this job last
// succeeded for this property, combined into one email per recipient.
//
// 7am local (D-3), alongside billing's due-notices job - a digest that
// arrives with the rest of a person's morning mail is read; one that fires
// at 2am local because the job ran on UTC's clock is not.
//
// THE WINDOW IS THE JOB'S OWN LAST RUN, not a fixed 24h lookback. `JobRun`
// (R-006) already records exactly when this job type last succeeded for
// this property, so reusing it means a missed day catches up correctly
// (a two-day window, once) and a normal day never double-counts an item a
// prior run already sent - a fixed "since yesterday" guess could do either
// depending on exactly when each tick happens to land.
const LOCAL_HOUR = 7
const JOB_TYPE = 'notifications.daily_digest'

SCHEDULED_JOBS.push({
  type: JOB_TYPE,
  localHour: LOCAL_HOUR,
  description:
    'One combined email per recipient for everything batched under the digest_daily preference since this job last ran (NOTIF-04).',
  run: async ({ propertyId, timezone, now }) => {
    const windowStart = await digestWindowStart(propertyId, now)

    const batched = await prisma.notification.findMany({
      where: {
        propertyId,
        createdAt: { gte: windowStart, lt: now },
        delivery: { suppressedReason: 'digest_batched' },
      },
      select: {
        recipientType: true,
        recipientId: true,
        toAddress: true,
        subject: true,
        body: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    // Grouped by recipient, not sent per row - that IS the digest. The
    // address is read straight off the batched rows rather than looked up
    // again on Tenant/StaffUser: it is the address each one was actually
    // headed to, and a digest that used a different (newer) address than
    // the messages it is summarizing would be describing sends that never
    // happened to that inbox.
    const byRecipient = new Map<
      string,
      {
        type: (typeof batched)[number]['recipientType']
        id: string
        toAddress: string
        items: { subject: string | null; body: string }[]
      }
    >()
    for (const row of batched) {
      const key = `${row.recipientType}:${row.recipientId}`
      const group = byRecipient.get(key) ?? {
        type: row.recipientType,
        id: row.recipientId,
        toAddress: row.toAddress,
        items: [],
      }
      group.items.push({ subject: row.subject, body: row.body })
      byRecipient.set(key, group)
    }

    const day = businessDate(now, timezone)
    for (const group of byRecipient.values()) {
      await notify({
        category: 'digest_daily',
        templateKey: 'notifications.digest_daily',
        recipient: { type: group.type, id: group.id, email: group.toAddress },
        context: { items: group.items },
        propertyId,
        // One digest per recipient per property-local day (D-3) - a second
        // tick the same morning must not send a second email.
        idempotencyKey: `digest:${group.type}:${group.id}:${day}`,
      })
    }

    return { recipients: byRecipient.size, itemsBatched: batched.length }
  },
})

async function digestWindowStart(propertyId: string, now: Date): Promise<Date> {
  const lastRun = await prisma.jobRun.findFirst({
    where: { jobType: JOB_TYPE, propertyId, status: 'SUCCEEDED' },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  })
  // No prior run: a plain 24h lookback rather than "since forever", so a
  // property's first-ever digest cannot pull in months of batched rows that
  // predate the preference even existing.
  return lastRun?.startedAt ?? new Date(now.getTime() - 24 * 60 * 60 * 1000)
}
