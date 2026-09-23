import 'server-only'

import { utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// Its own file, not part of rent-change.ts: that module reaches the Auth.js
// stack, which a vitest file cannot load.

/**
 * Tells the tenant a scheduled increase was withdrawn, outside the
 * transaction. Silent when the notice was never served: they were never told
 * of the increase, so there is nothing to take back.
 */
export async function notifyRentIncreaseWithdrawn(rentChangeId: string): Promise<void> {
  try {
    const change = await prisma.rentChange.findUniqueOrThrow({
      where: { id: rentChangeId },
      select: {
        effectiveOn: true,
        notice: { select: { servedAt: true } },
        lease: {
          select: {
            propertyId: true,
            property: { select: { addressLine1: true } },
            leaseTenants: {
              where: { isPrimary: true },
              select: { tenant: { select: { id: true, firstName: true, email: true, phone: true } } },
            },
          },
        },
      },
    })
    const tenant = change.lease.leaseTenants[0]?.tenant
    if (!tenant || !change.notice.servedAt) return
    const outcomes = await notify({
      category: 'legal_notice',
      templateKey: 'lease.rent_increase_withdrawn',
      recipient: { type: 'TENANT', id: tenant.id, email: tenant.email, phone: tenant.phone },
      context: {
        tenantName: tenant.firstName,
        addressLine1: change.lease.property.addressLine1,
        effectiveOn: utcToBusinessDate(change.effectiveOn),
      },
      propertyId: change.lease.propertyId,
      idempotencyKey: `rent-increase-withdrawn:${rentChangeId}`,
    })
    await dispatchPendingNotifications(new Date(), 100, {
      deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
    })
  } catch (error) {
    console.error(`[leases] failed to notify tenant of withdrawn rent increase ${rentChangeId}`, error)
  }
}
