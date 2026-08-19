'use server'

import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

// STAFF writes for Showing (LEASE-08, R-064) - separate from actions.ts,
// which has to stay import-clean of lib/audit/index.ts (and therefore of
// Auth.js) so it can be tested with no session at all. Same wall
// prospects/staff-actions.ts's own header documents.

export interface CancelResult {
  error?: string
}

/**
 * Withdraws a booked showing - a prospect calls to cancel, or the unit is
 * no longer available. Also cancels the escort Task raised at booking
 * (D-9): a cancelled showing with an open Task would sit in the staff
 * queue forever pointing at a visit that is not happening.
 *
 * The entry notice, if one was served, is left alone - a cancelled showing
 * does not un-serve a notice that already went out, and no other flow reads
 * `Showing.entryNoticeId` to imply the visit still stands.
 */
export async function cancelShowing(showingId: string): Promise<CancelResult> {
  const showing = await prisma.showing.findUniqueOrThrow({
    where: { id: showingId },
    include: { property: true },
  })
  await requirePermission('lease.write', propertyResource(showing.property))

  if (showing.status === 'CANCELED') {
    return { error: 'Already cancelled.' }
  }

  await prisma.$transaction(async (tx) => {
    await tx.showing.update({
      where: { id: showingId },
      data: { status: 'CANCELED', canceledAt: new Date() },
    })
    await tx.task.updateMany({
      where: { subjectType: 'Showing', subjectId: showingId, status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] } },
      data: { status: 'CANCELED', completedAt: new Date() },
    })
    await audit(
      {
        action: 'showing.canceled',
        entityType: 'Showing',
        entityId: showingId,
        propertyId: showing.propertyId,
        before: { status: showing.status },
        after: { status: 'CANCELED' },
      },
      tx,
    )
  })

  revalidatePath(`/prospects/${showing.prospectId}`)
  return {}
}
