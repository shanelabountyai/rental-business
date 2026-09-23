import 'server-only'

import { prisma } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'

// NOT a 'use server' module, on purpose (SEC-01). `leaseIds` is the caller's
// word for which leases the reader holds; as an action export anybody could
// supply it, and forge the read receipt that is the only proof of PORTAL
// service. The two portal pages pass it from the signed-in session.

/**
 * The portal read receipt: the tenant opened a notice served to them there
 * (COMM-02's "portal delivery with read receipt").
 *
 * For PORTAL service this is the ONLY evidence the notice reached anybody, so
 * it is written from the tenant's own authenticated view of the notice and
 * never from a staff screen.
 *
 * Write-once at the database (see the migration's trigger). This checks first
 * anyway so the ordinary second visit is a no-op rather than a caught
 * exception, and swallows a lost race deliberately: two tabs opening the same
 * notice must not 500 the page the tenant is trying to read.
 */
export async function markNoticeRead(noticeId: string, leaseIds: readonly string[]): Promise<void> {
  if (leaseIds.length === 0) return

  const delivery = await prisma.noticeDelivery.findFirst({
    where: {
      noticeId,
      method: 'PORTAL',
      readAt: null,
      notice: { leaseId: { in: [...leaseIds] } },
    },
    select: { id: true, notice: { select: { propertyId: true } } },
  })
  if (!delivery) return

  try {
    await prisma.$transaction(async (tx) => {
      await tx.noticeDelivery.update({
        where: { id: delivery.id },
        data: { readAt: new Date() },
      })
      await audit(
        {
          action: 'notice.read',
          entityType: 'Notice',
          entityId: noticeId,
          propertyId: delivery.notice.propertyId,
          after: { deliveryId: delivery.id },
        },
        tx,
      )
    })
  } catch (error) {
    // The trigger refuses a second write, which is the guarantee working.
    console.error(`[notice] could not record read receipt for ${noticeId}`, error)
  }
}
