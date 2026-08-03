import 'server-only'

import { recordAudit } from '@rental/core/audit'
import { businessDateToUtc } from '@rental/core/scheduling'
import { type LeaseStatus, prisma } from '@rental/db'
import { emitEvent } from '@/lib/jobs/outbox.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'

// recordAudit straight from packages/core/audit, not the app-layer
// auditAsSystem() wrapper in @/lib/audit/index.ts: that wrapper's whole job is
// resolving the CURRENT REQUEST's actor, and it imports auth.ts (Auth.js) to
// do it. A background job has no request and its actor is unconditionally
// SYSTEM, so going through the wrapper only adds an import that cannot
// resolve under Vitest (the same next-auth/next-server chain R-004 and R-008
// hit and split scope.ts out to avoid) for no benefit.

// PROP-02: "Given a unit whose lease ends without renewal, when the end date
// passes, then unit status auto-transitions to make-ready."
//
// Registers itself into R-006's SCHEDULED_JOBS by being imported - see
// apps/web/lib/jobs/registrations.ts, which is the one place that imports
// every job module for this side effect. Importing this file anywhere else
// would register the job a second time under a different module instance;
// registrations.ts is deliberately the only place that does.
//
// "Without renewal" is read narrowly: a SUCCESSOR lease already exists for
// the same unit (any status that means "this lease is going to happen or is
// happening" - DRAFT, PENDING_SIGNATURE, ACTIVE, MONTH_TO_MONTH - starting on
// or after this one's end date). If one exists, the unit is left alone; the
// process that activates the new lease owns what happens to the unit next,
// not this job. R-033 has not built lease activation yet, so today this
// check is exercised only against directly-seeded Lease rows, exactly as
// R-006's own scheduled-job tests exercised jobs before any real consumer
// existed.
const LOCAL_HOUR = 3

const IN_FORCE: LeaseStatus[] = ['ACTIVE', 'MONTH_TO_MONTH']
const COUNTS_AS_RENEWAL: LeaseStatus[] = [
  'DRAFT',
  'PENDING_SIGNATURE',
  'ACTIVE',
  'MONTH_TO_MONTH',
]

SCHEDULED_JOBS.push({
  type: 'unit.auto_make_ready',
  localHour: LOCAL_HOUR,
  description:
    'Flips a unit to MAKE_READY once its lease has ended without a renewal in place (PROP-02).',
  run: async ({ propertyId, businessDate }) => {
    // Strictly BEFORE today, not on-or-before: a lease ending today is not
    // yet over, and treating its last day as already-vacant would flip the
    // unit while a move-out could still be in progress.
    const asOf = businessDateToUtc(businessDate)

    const endedLeases = await prisma.lease.findMany({
      where: {
        propertyId,
        status: { in: IN_FORCE },
        endsOn: { not: null, lt: asOf },
        unit: { status: 'OCCUPIED' },
      },
      select: { id: true, unitId: true, endsOn: true },
    })

    let transitioned = 0
    for (const lease of endedLeases) {
      const successor = await prisma.lease.findFirst({
        where: {
          unitId: lease.unitId,
          id: { not: lease.id },
          status: { in: COUNTS_AS_RENEWAL },
          startsOn: { gte: lease.endsOn! },
        },
        select: { id: true },
      })
      if (successor) continue

      // Re-checks the unit is STILL occupied inside the transaction: two
      // ended leases on the same unit (should not happen, but the query above
      // does not prevent it) must not both fire the transition and both
      // report success.
      await prisma.$transaction(async (tx) => {
        const updated = await tx.unit.updateMany({
          where: { id: lease.unitId, status: 'OCCUPIED' },
          data: { status: 'MAKE_READY' },
        })
        if (updated.count === 0) return

        await emitEvent(tx, {
          type: 'unit.became_make_ready',
          aggregateType: 'Unit',
          aggregateId: lease.unitId,
          propertyId,
          payload: { leaseId: lease.id, leaseEndedOn: lease.endsOn!.toISOString() },
        })

        await recordAudit(tx, {
          actor: { type: 'SYSTEM', ref: 'unit.auto_make_ready' },
          action: 'unit.auto_made_ready',
          entityType: 'Unit',
          entityId: lease.unitId,
          propertyId,
          before: { status: 'OCCUPIED' },
          after: { status: 'MAKE_READY' },
        })
      })
      transitioned++
    }

    return { checked: endedLeases.length, transitioned }
  },
})
