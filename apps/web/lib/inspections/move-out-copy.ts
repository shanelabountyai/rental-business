import 'server-only'

import type { Prisma, PrismaClient } from '@rental/db'

// What a MOVE_OUT or PRE_MOVE_OUT inspection's checklist is built from
// (INSP-02, R-070): the SAME rooms/items the lease's own move-in inspection
// walked, each new item linked back to its move-in counterpart via
// `InspectionItem.moveInItemId` - the real FK the schema's own comment
// already names as "the side-by-side comparison, the deposit-disposition
// evidence". Shared by `startInspection` (a staff member starting one by
// hand) and `pre-move-out-scheduling-job.ts` (the automatic one), so the
// two never drift on how a pairing is built.

type Db = PrismaClient | Prisma.TransactionClient

export interface ResolvedItem {
  room: string
  item: string
  order: number
  moveInItemId: string | null
}

export interface MoveInCopy {
  sourceInspectionId: string
  items: ResolvedItem[]
}

/**
 * The lease's own most recent MOVE_IN inspection, copied into fresh items -
 * or `null` when there is nothing to copy: no `leaseId` resolved, or a
 * lease with no move-in inspection on record (an inherited tenancy with no
 * application-derived baseline, R-033, or a unit inspected before any
 * lease existed). The caller falls back to a template in that case, same as
 * every inspection type before this item.
 */
export async function itemsFromMoveIn(db: Db, leaseId: string | null): Promise<MoveInCopy | null> {
  if (!leaseId) return null
  const moveIn = await db.inspection.findFirst({
    where: { leaseId, type: 'MOVE_IN' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      items: {
        orderBy: { order: 'asc' },
        select: { id: true, room: true, item: true, order: true },
      },
    },
  })
  if (!moveIn || moveIn.items.length === 0) return null

  return {
    sourceInspectionId: moveIn.id,
    items: moveIn.items.map((row) => ({
      room: row.room,
      item: row.item,
      order: row.order,
      moveInItemId: row.id,
    })),
  }
}
