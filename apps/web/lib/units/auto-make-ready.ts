import 'server-only'

import { recordAudit } from '@rental/core/audit'
import { businessDateToUtc } from '@rental/core/scheduling'
import { type LeaseStatus, prisma } from '@rental/db'
import { emitEvent } from '@/lib/jobs/outbox.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { retireUnitAccessCodes } from '@/lib/locks/access-codes.ts'
import { startTurnoverProjectForLease } from '@/lib/turnover/start.ts'

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
//
// R-222: A PASSED `endsOn` IS NOT A MOVE-OUT. A fixed term that runs out with
// no renewal does not end - `lease.mtm_rollover` (renewal-rollover-job.ts)
// rolls it to month-to-month an hour after this job, and a lease under notice
// whose tenant has not left is a holdover, not a vacancy. This job used to
// take the passed date as the move-out: it stamped a `moveOutAt` that never
// happened, retired the family's door codes and opened a re-key turn on an
// occupied house while Stripe kept billing it. Only a RECORDED move-out may
// make the unit ready; an ENDED or TERMINATED lease already did so on the
// manual path (`changeLeaseStatus`). Existing false `moveOutAt` stamps are
// deliberately not backfilled (review 2026-09-17, "Do not build").
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
        moveOutAt: { not: null },
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
      const madeReady = await prisma.$transaction(async (tx) => {
        const updated = await tx.unit.updateMany({
          where: { id: lease.unitId, status: 'OCCUPIED' },
          data: { status: 'MAKE_READY' },
        })
        if (updated.count === 0) return false

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

        // R-176. The same retire `changeLeaseStatus` does on the manual
        // path, in this transaction for the same reason - and it matters
        // MORE here, because a lease that lapsed unattended is one nobody
        // walked out of, so nothing else is going to prompt anybody to think
        // about the keypad. See `retireUnitAccessCodes` for why this changes
        // no lock and `startTurnoverProjectForLease` below for what does.
        const retired = await retireUnitAccessCodes(tx, lease.unitId)
        if (retired > 0) {
          await recordAudit(tx, {
            actor: { type: 'SYSTEM', ref: 'unit.auto_make_ready' },
            action: 'accesscode.retired_on_move_out',
            entityType: 'Lease',
            entityId: lease.id,
            propertyId,
            after: { unitId: lease.unitId, retiredCount: retired },
          })
        }
        return true
      })
      if (!madeReady) continue
      transitioned++

      // Outside the transaction, same "a failure here must not undo the
      // transition just committed" posture every other post-commit side
      // effect in this codebase takes (LEASE-12, R-072).
      await startTurnoverProjectForLease(lease.id).catch((error) => {
        console.error(`[units] turnover project start failed for ${lease.id}`, error)
      })
    }

    return { checked: endedLeases.length, transitioned }
  },
})
