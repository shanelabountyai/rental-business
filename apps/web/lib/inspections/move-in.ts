import 'server-only'

import type { Prisma } from '@rental/db'

// `Lease.moveInAt` had no writer anywhere in the codebase until R-172, so
// `getTurnoverForUnit`'s `where: { moveInAt: { not: null } }` matched
// nothing and a unit filled last March still read "179 days vacant and
// counting" for ever. This is that writer, shared behind BOTH walk-finish
// paths - the staff one (lib/inspections/actions.ts) and the tenant's own
// self-guided one (lib/portal/inspection-actions.ts) - the same call
// `writeItemCondition` next door already made for the identical drift.
//
// WHY THE MOVE-IN WALK AND NOT LEASE ACTIVATION. `Lease.activatedAt` is
// already written by all three activation paths and would have been a
// one-token change, but it is the moment the tenancy went LIVE - usually
// signing day, often weeks before anybody has a key. Using it would make
// `moveInAt` a WORSE answer than the `startsOn` fallback it is supposed to
// improve on. The move-in walk is the handover itself.
//
// The review finding also named key/code issuance. It is not usable:
// `AccessCode` is versioned per (unitId, type) and rotates for vendors and
// maintenance, so a new row is not evidence a tenant took possession.
//
// FIRST WRITER WINS. `updateMany` filtered on `moveInAt: null` so a PM who
// recorded the real handover date is never overwritten by the moment
// somebody got round to finishing the walk - the same posture
// `changeLeaseStatus` takes for `moveOutAt`.
export async function recordMoveInFromWalk(
  tx: Prisma.TransactionClient,
  inspection: { type: string; leaseId: string | null },
  at: Date,
): Promise<void> {
  if (inspection.type !== 'MOVE_IN' || !inspection.leaseId) return
  await tx.lease.updateMany({
    where: { id: inspection.leaseId, moveInAt: null },
    data: { moveInAt: at },
  })
}
