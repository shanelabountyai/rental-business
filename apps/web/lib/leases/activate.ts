import 'server-only'

import { emitEvent, type OutboxDb } from '@/lib/jobs/outbox.ts'

// The side effects of a lease going live, shared by two callers: the staff
// status-change action (`changeLeaseStatus`, DRAFT/inherited straight to
// ACTIVE) and the esign completion path (`esign-actions.ts`'s
// `signLeaseDocument`, once every signer has signed and the lease moves
// PENDING_SIGNATURE -> ACTIVE with no staff session at all).
//
// EXTRACTED RATHER THAN DUPLICATED (the ladder's "already in this codebase"
// rung): the unit-occupies-and-delists behavior is a single fact about what
// "going live" means, and R-057's own comment on the `lease.activated`
// event already calls out that a straight-to-ACTIVE lease and a
// PENDING_SIGNATURE one activating both have to fire it identically. Two
// near-identical fifteen-line blocks would have been the shape that lets
// them drift.
//
// DOES NOT write the lease's own status column or its audit entry - those
// differ enough between the two callers (a staff actor vs. a SYSTEM one,
// `audit()` vs `auditAsSystem()`) that folding them in here would just move
// the branching, not remove it.

export async function activateLeaseSideEffects(
  db: OutboxDb,
  lease: { id: string; unitId: string; propertyId: string },
): Promise<void> {
  await db.unit.updateMany({
    where: { id: lease.unitId },
    data: { status: 'OCCUPIED' },
  })
  await emitEvent(db, {
    type: 'lease.activated',
    aggregateType: 'Lease',
    aggregateId: lease.id,
    propertyId: lease.propertyId,
    payload: { unitId: lease.unitId },
  })
}

// The renewal predecessor's end, shared by the SAME two callers' renewal
// branches (`completeEnvelope`'s same-day case and the cutover job). One
// writer on purpose (R-154): every deposit reader keys off `lease.deposits`,
// so a renewal that ends the predecessor without re-pointing its `Deposit`
// rows leaves the successor tenancy with no deposit at all - no
// `dispositionDueOn` clock, no statutory letter, a rent roll printing $0.00
// held (D-54's continuity gap, review finding 2). The money never moved and
// the tenant never left; only the lease row changed, so the liability row
// follows the live tenancy. `Deposit` is not append-only, and its
// disposition cannot have started here - the predecessor is still the live
// tenancy at cutover, so `moveOutAt` is unset and `dispositionDueOn` null.
export async function endRenewalPredecessor(
  db: OutboxDb,
  args: { predecessorId: string; successorId: string },
): Promise<{ movedDepositIds: string[] }> {
  const deposits = await db.deposit.findMany({
    where: { leaseId: args.predecessorId },
    select: { id: true },
  })
  await db.deposit.updateMany({
    where: { leaseId: args.predecessorId },
    data: { leaseId: args.successorId },
  })
  await db.lease.update({
    where: { id: args.predecessorId },
    data: { status: 'ENDED' },
  })
  return { movedDepositIds: deposits.map((deposit) => deposit.id) }
}
