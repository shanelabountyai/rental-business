import 'server-only'

import { recordAudit } from '@rental/core/audit'
import { TURN_SEQUENCE, type SequencedStage } from '@rental/core/turnover'
import { prisma, type TurnoverProject } from '@rental/db'

// `recordAudit` straight from core rather than the app-layer `audit()`
// wrapper, the same call `auto-make-ready.ts` makes and for its reason: one
// of this function's two callers is a background job with no request to
// resolve an actor from, and the wrapper imports Auth.js to do that.

export const REKEY_SCOPE =
  'Re-key the unit - the departing tenant may still hold a working key'

/**
 * THE TURN TEMPLATE (R-178, review §10). One work order per sequenced stage,
 * opened with the turn.
 *
 * Real rows rather than a derived checklist, because a stage you cannot
 * assign a vendor to, schedule, or price is not a stage anybody can work -
 * the dispatch, scheduling, approval and cost machinery R-024 built all hangs
 * off `WorkOrder`, and the review's complaint is precisely that a turn today
 * is "a bag of work orders with `turnoverStage: null`". The template is what
 * puts a stage on the board before somebody remembers to.
 *
 * A LINE THIS TURN DOES NOT NEED IS CANCELED, NOT DELETED. `stageWorkIsOpen`
 * treats CANCELED as nothing left to wait for, so canceling the floors line
 * on a unit with sound hardwood unblocks clean and stops the stall sweep
 * counting it - and the record still says somebody looked at floors and
 * decided. That is the whole reason the template can afford to be
 * opinionated.
 */
const TURN_TEMPLATE_SCOPES: Record<SequencedStage, string> = {
  TRASH_OUT: 'Trash-out - clear everything the departing tenant left behind',
  REPAIRS: 'Repairs - the move-out punch list',
  PAINT: 'Paint - touch up or repaint as the walk found',
  FLOORS: 'Floors - clean, repair or replace',
  CLEAN: 'Final clean before the unit is shown',
  REKEY: REKEY_SCOPE,
}

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

  return prisma.$transaction(async (tx) => {
    const project = await tx.turnoverProject.upsert({
      where: { leaseId: lease.id },
      create: { propertyId: lease.propertyId, unitId: lease.unitId, leaseId: lease.id },
      // A no-op write to the row that already exists - upsert requires a
      // non-empty `update`, and reassigning the same propertyId is the
      // harmless value already on it.
      update: { propertyId: lease.propertyId },
    })

    // R-178. The template, instantiated here rather than left for a PM to
    // remember - the item's whole premise. R-176 already did this for the
    // one stage that could not wait; this is the other five on the same
    // machinery.
    //
    // IDEMPOTENT ON "a work order already exists at this stage", not on
    // which upsert branch ran: the whole contract of this function is that a
    // re-run is a no-op, and a turn whose paint somebody has already added by
    // hand does not want a second line. Two concurrent first-calls could
    // still both insert - there is no unique key to lean on, and a duplicate
    // line on a punch list is a cosmetic problem, not a safety one.
    const staged = await tx.workOrder.findMany({
      where: { turnoverProjectId: project.id, turnoverStage: { in: [...TURN_SEQUENCE] } },
      select: { turnoverStage: true },
    })
    const present = new Set(staged.map((workOrder) => workOrder.turnoverStage))

    for (const stage of TURN_SEQUENCE) {
      if (present.has(stage)) continue
      const workOrder = await tx.workOrder.create({
        data: {
          propertyId: project.propertyId,
          unitId: project.unitId,
          turnoverProjectId: project.id,
          turnoverStage: stage,
          // R-176. THE RE-KEY is URGENT, not ROUTINE like the rest of the
          // template and not EMERGENCY. Ending the tenancy retires our record
          // of the unit's keypad codes (`retireUnitAccessCodes`) - it changes
          // no physical lock, and a departing tenant who copied a key still
          // has one. Until this closes, somebody who no longer lives there can
          // open the door: that outranks paint. Emergency is R-029's
          // after-hours paging tier and would wake a rota for a vacant unit.
          priority: stage === 'REKEY' ? 'URGENT' : 'ROUTINE',
          scope: TURN_TEMPLATE_SCOPES[stage],
        },
      })
      await recordAudit(tx, {
        actor: { type: 'SYSTEM', ref: 'turnover.start' },
        action: 'workorder.created',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        propertyId: project.propertyId,
        after: { scope: workOrder.scope, priority: workOrder.priority, ticketId: null },
      })
    }

    return project
  })
}
