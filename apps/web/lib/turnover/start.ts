import 'server-only'

import { prisma, type TurnoverProject } from '@rental/db'

// The one place anything creates a TurnoverProject (LEASE-12, R-072).
// Called post-commit, best-effort, from both places a unit goes MAKE_READY:
// the manual status change in `leases/actions.ts` and the nightly
// `unit.auto_make_ready` job - same "right after that transition commits,
// a failure here must not undo the tenancy ending" posture
// `startDepositDisposition` already established for the sibling side effect
// that starts on the same event.
//
// Reads `Lease.moveOutAt` rather than taking it as a parameter: the two
// call sites set it two different ways (the exact instant a PM clicks the
// button, or the lease's own `endsOn` for one that lapsed unattended), and
// reading it back is cheaper than trusting two copies to agree.

/**
 * Starts the turn, or returns the one that already exists for this lease -
 * `TurnoverProject.leaseId` is unique, one turn per move-out. `upsert`, not
 * create-then-catch: a plain `create` racing a duplicate throws P2002, and
 * this function commits its own transaction rather than joining a caller's,
 * so there is no shared connection an aborted insert could poison - `upsert`
 * is simply the version with no error path to think about.
 *
 * `null` when the lease has no `moveOutAt` yet - nothing to start a clock
 * from, not an error.
 */
export async function startTurnoverProjectForLease(
  leaseId: string,
): Promise<TurnoverProject | null> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: { id: true, propertyId: true, unitId: true, moveOutAt: true },
  })
  if (!lease.moveOutAt) return null

  return prisma.turnoverProject.upsert({
    where: { leaseId: lease.id },
    create: { propertyId: lease.propertyId, unitId: lease.unitId, leaseId: lease.id },
    // A no-op write to the row that already exists - upsert requires a
    // non-empty `update`, and reassigning the same propertyId is the
    // harmless value already on it.
    update: { propertyId: lease.propertyId },
  })
}
