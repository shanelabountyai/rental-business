import 'server-only'

import { type AuditActor, recordAudit } from '@rental/core/audit'
import { isFixableCondition } from '@rental/core/inspections'
import type { Prisma } from '@rental/db'

// INSP-06 (R-072): a locked MOVE_OUT inspection auto-drafts the turnover's
// punch list. Called from INSIDE `lockInspection`'s own transaction, not
// after it commits - the lock and the draft it produces are one fact, not
// two a partial failure could split.
//
// `recordAudit` directly, not the app-layer `audit()` wrapper: this module
// takes its actor as a parameter rather than resolving it from the current
// request, the same "physically separate from anything Auth.js-dependent"
// split R-058 already established for staying Vitest-testable - `audit()`
// imports next-auth's session chain, which has no test-runtime shape.

export interface PunchListItemSource {
  room: string
  item: string
  condition: string | null
  notes: string | null
}

/**
 * A no-op for anything but a MOVE_OUT inspection tied to a lease, and for a
 * lease with no `TurnoverProject` yet - the normal order is the lease
 * formally ending (which starts the project, see `startTurnoverProjectForLease`)
 * BEFORE the vacated unit gets walked and its report locked. If a report is
 * locked ahead of that, nothing here retroactively catches up - INSP-01's
 * own "immutable evidence from lock" means this is the only moment the
 * draft can happen, and there is deliberately no project to create one
 * against here (that would mean creating a turnover before knowing there
 * was actually a move-out, which is the fact the whole clock is anchored
 * on).
 *
 * One `WorkOrder` per item at POOR/DAMAGED/MISSING (`isFixableCondition`,
 * the same threshold the pre-move-out walkthrough's own "still fixable"
 * list already uses) - ticketless and unstaged (`turnoverStage` null),
 * same as every other punch-list line: a PM triages the stage, not a
 * guess made here from the room name.
 */
export async function draftPunchListFromInspection(
  tx: Prisma.TransactionClient,
  inspection: { id: string; propertyId: string; unitId: string; leaseId: string | null; type: string },
  items: readonly PunchListItemSource[],
  actor: AuditActor,
): Promise<number> {
  if (inspection.type !== 'MOVE_OUT' || !inspection.leaseId) return 0

  const project = await tx.turnoverProject.findUnique({ where: { leaseId: inspection.leaseId } })
  if (!project) return 0

  const findings = items.filter((entry) => isFixableCondition(entry.condition))
  if (findings.length === 0) return 0

  for (const finding of findings) {
    await tx.workOrder.create({
      data: {
        propertyId: inspection.propertyId,
        unitId: inspection.unitId,
        turnoverProjectId: project.id,
        priority: 'ROUTINE',
        scope: `${finding.room} — ${finding.item}${
          finding.notes ? `: ${finding.notes}` : ''
        } (move-out inspection finding)`,
      },
    })
  }

  await recordAudit(tx, {
    actor,
    action: 'turnover.punch_list_drafted',
    entityType: 'TurnoverProject',
    entityId: project.id,
    propertyId: inspection.propertyId,
    after: { inspectionId: inspection.id, count: findings.length },
  })

  return findings.length
}
