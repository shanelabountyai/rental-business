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
 * Every lease in this tenancy, OLDEST FIRST - `leaseId` itself last. A
 * fixed-term renewal is a new `Lease` row (D-54) linked back through
 * `renewedFromLeaseId`, so a tenant three renewals in lives on the fourth row
 * of a chain whose first row holds everything that happened at move-in.
 */
export async function tenancyLeaseIds(db: Db, leaseId: string): Promise<string[]> {
  const chain = [leaseId]
  for (let id: string | null = leaseId; id; ) {
    const lease: { renewedFromLeaseId: string | null } | null = await db.lease.findUnique({
      where: { id },
      select: { renewedFromLeaseId: true },
    })
    id = lease?.renewedFromLeaseId ?? null
    if (!id || chain.includes(id)) break
    chain.unshift(id)
  }
  return chain
}

/**
 * The move-in report a deposit case is measured from (R-226): the one taken
 * at the TRUE start of occupancy, on the tenancy's first lease - not the
 * current lease's, which for a renewal is none at all, because
 * `move-in-consumer.ts` deliberately opens no report for a renewal and
 * `endRenewalPredecessor` moves the Deposit rows across without it. Every
 * reader used to query `{ leaseId, type: 'MOVE_IN' }` on the current lease,
 * so a tenant who renewed even once reached move-out with a blank left-hand
 * side and every deduction flagged unsupported.
 *
 * The earliest lease in the chain that HAS one wins; within a lease, the
 * newest report, as before. A later lease's report only answers when every
 * earlier lease has none - a staff member opening one by hand on a renewal
 * of a tenancy that predates R-208.
 */
export async function baselineMoveInFor(
  db: Db,
  leaseId: string,
): Promise<{ id: string; leaseId: string; performedAt: Date | null } | null> {
  const chain = await tenancyLeaseIds(db, leaseId)
  const reports = await db.inspection.findMany({
    where: { leaseId: { in: chain }, type: 'MOVE_IN' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, leaseId: true, performedAt: true },
  })
  for (const id of chain) {
    const report = reports.find((row) => row.leaseId === id)
    if (report) return { id: report.id, leaseId: id, performedAt: report.performedAt }
  }
  return null
}

/**
 * The tenancy's baseline MOVE_IN inspection (`baselineMoveInFor`), copied
 * into fresh items - or `null` when there is nothing to copy: no `leaseId`
 * resolved, or a tenancy with no move-in inspection on record (an inherited
 * tenancy with no application-derived baseline, R-033, or a unit inspected
 * before any lease existed). The caller falls back to a template in that
 * case, same as every inspection type before this item.
 */
export async function itemsFromMoveIn(db: Db, leaseId: string | null): Promise<MoveInCopy | null> {
  if (!leaseId) return null
  const baseline = await baselineMoveInFor(db, leaseId)
  if (!baseline) return null
  const moveIn = await db.inspection.findUnique({
    where: { id: baseline.id },
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
