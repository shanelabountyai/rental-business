import 'server-only'

import { businessDate, friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { createTask } from '@/lib/tasks/create.ts'

// Start the marketing clock when a notice to vacate lands (R-219, LEASE-12).
//
// The notice period is the only stretch of a turn when the unit costs nothing
// to market: photograph, price, publish and book showings against an occupied
// home (R-064 already handles that showing's entry notice). Nothing prompted
// it, so the clock started at move-out.
//
// PULL, NOT PUSH, for the same reason pre-move-out-scheduling-job.ts gives:
// `noticeGivenAt` is the one fact four different writers set (tenant portal,
// staff notice or non-renewal, SCRA termination, confidential early
// termination). A daily read of that column covers all four and any fifth,
// where a hook in each action would miss the next one somebody adds.
//
// Dated on the NOTICE day, not the day the job ran, so the Task shows its
// true age and the idempotency key (type, unit, notice day) is stable across
// every nightly run. Publishing stays a deliberate act: this only prompts.
const LOCAL_HOUR = 4

SCHEDULED_JOBS.push({
  type: 'listing.prepare',
  localHour: LOCAL_HOUR,
  description:
    'Raises a listing.prepare Task for a unit whose lease is under notice and which has no listing started since the notice (LEASE-12).',
  run: async ({ propertyId }) => {
    const property = await prisma.property.findUniqueOrThrow({
      where: { id: propertyId },
      select: { timezone: true },
    })

    const leases = await prisma.lease.findMany({
      where: {
        propertyId,
        status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] },
        noticeGivenAt: { not: null },
        noticeEffectiveOn: { not: null },
      },
      select: {
        unitId: true,
        noticeGivenAt: true,
        noticeEffectiveOn: true,
        unit: {
          select: {
            name: true,
            listings: { select: { status: true, createdAt: true } },
          },
        },
      },
    })

    let raised = 0
    for (const lease of leases) {
      const givenAt = lease.noticeGivenAt!
      // Already in hand: a listing is live, or somebody started one after the
      // notice. An old DRAFT from the previous vacancy does not count.
      const started = lease.unit.listings.some(
        (listing) => listing.status === 'PUBLISHED' || listing.createdAt >= givenAt,
      )
      if (started) continue

      const { created } = await createTask(prisma, {
        propertyId,
        type: 'listing.prepare',
        subjectType: 'Unit',
        subjectId: lease.unitId,
        businessDate: businessDate(givenAt, property.timezone),
        priority: 'ROUTINE',
        title: `Prepare the listing for ${lease.unit.name} — notice to vacate for ${friendlyBusinessDate(utcToBusinessDate(lease.noticeEffectiveOn!))}`,
      })
      if (created) raised++
    }

    return { checked: leases.length, raised }
  },
})
