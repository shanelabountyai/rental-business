import 'server-only'

import { daysUntilExpiry, expiryWindow } from '@rental/core/leases'
import { utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { createTask } from '@/lib/tasks/create.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'

// The 120/90-day renewal flag (LEASE-09, R-065): "Given a lease inside the
// renewal window, when the window opens, then a renewal task is created and
// the owner sees current vs. proposed rent."
//
// recordAudit straight from packages/core/audit would be the usual call
// here, but there is nothing to audit - raising a Task is not a privileged
// mutation on a tenancy, it is a work-queue entry, the same posture
// auto-make-ready's own unit-status flip earns an audit entry for and this
// does not.
//
// FLAGGED ONCE, NOT EVERY DAY INSIDE THE WINDOW. createTask()'s own
// (type, subjectId, businessDate) idempotency stops a double-fire on ONE
// day, but this job runs once per property-local day for up to 120 days
// straight for the same lease - without a check of its own it would raise a
// fresh Task every single day the lease sits inside the window. Checked
// directly here (ANY existing lease_renewal task for this lease, any
// status) rather than relying on createTask's daily key.
const LOCAL_HOUR = 2

SCHEDULED_JOBS.push({
  type: 'lease.renewal_window',
  localHour: LOCAL_HOUR,
  description:
    'Flags a fixed-term lease once it enters its 120/90-day renewal window (LEASE-09).',
  run: async ({ propertyId, businessDate: today }) => {
    const leases = await prisma.lease.findMany({
      where: { propertyId, status: 'ACTIVE', endsOn: { not: null } },
      select: { id: true, endsOn: true, rentCents: true, unit: { select: { name: true } } },
    })

    let flagged = 0
    for (const lease of leases) {
      const window = expiryWindow(daysUntilExpiry(utcToBusinessDate(lease.endsOn!), today))
      if (window == null) continue

      const alreadyFlagged = await prisma.task.findFirst({
        where: { type: 'lease_renewal', subjectId: lease.id },
        select: { id: true },
      })
      if (alreadyFlagged) continue

      await createTask(prisma, {
        propertyId,
        type: 'lease_renewal',
        subjectType: 'Lease',
        subjectId: lease.id,
        businessDate: today,
        priority: 'ROUTINE',
        title: `Renewal window open (${window}-day) - ${lease.unit.name}`,
      })
      flagged++
    }

    return { checked: leases.length, flagged }
  },
})
