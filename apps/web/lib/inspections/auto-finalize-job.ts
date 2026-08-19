import 'server-only'

import { businessDate, businessDaysBetween } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// Auto-finalize (INSP-01, R-068 phase 2): "or it auto-finalizes after a
// stated response window; the report locks immutably against the lease."
//
// THREE DAYS, a literal constant - the same posture every sibling job in
// this codebase takes for a window nothing configures (renter-insurance-job.ts's
// own EXPIRING_SOON_DAYS, renewal-window-job.ts's own flag days): there is
// no JurisdictionRule concept for an inspection review window, and
// inventing one for a single, non-statutory consumer would be config for a
// number nobody has asked to vary. Short on purpose - a tenant who read the
// walk-through in person (INSP-01's own framing) does not need a long
// deliberation window, and the report locking promptly is what keeps the
// deposit-defense clock (R-071) honest.
const SIGNATURE_WINDOW_DAYS = 3
const LOCAL_HOUR = 6

SCHEDULED_JOBS.push({
  type: 'inspection.auto_finalize',
  localHour: LOCAL_HOUR,
  description:
    'Locks a performed-but-unsigned inspection report once the signature window elapses (INSP-01).',
  run: async ({ propertyId, businessDate: today }) => {
    const candidates = await prisma.inspection.findMany({
      where: { propertyId, performedAt: { not: null }, tenantSignedAt: null, lockedAt: null },
      select: {
        id: true,
        leaseId: true,
        performedAt: true,
        property: { select: { addressLine1: true, timezone: true } },
        unit: { select: { name: true } },
      },
    })

    let finalized = 0
    for (const inspection of candidates) {
      const performedOn = businessDate(inspection.performedAt!, inspection.property.timezone)
      if (businessDaysBetween(performedOn, today) < SIGNATURE_WINDOW_DAYS) continue

      await prisma.$transaction(async (tx) => {
        await tx.inspection.update({ where: { id: inspection.id }, data: { lockedAt: new Date() } })
        await auditAsSystem(
          'inspection.auto_finalize',
          {
            action: 'inspection.locked',
            entityType: 'Inspection',
            entityId: inspection.id,
            propertyId,
            after: { autoFinalized: true, windowDays: SIGNATURE_WINDOW_DAYS },
          },
          tx,
        )
      })
      finalized++

      if (inspection.leaseId) {
        try {
          const primaryTenant = await prisma.leaseTenant.findFirst({
            where: { leaseId: inspection.leaseId, isPrimary: true },
            include: { tenant: { select: { id: true, firstName: true, email: true, phone: true } } },
          })
          if (primaryTenant) {
            const outcomes = await notify({
              category: 'inspection_signature',
              templateKey: 'inspection.auto_finalized',
              recipient: {
                type: 'TENANT',
                id: primaryTenant.tenant.id,
                email: primaryTenant.tenant.email,
                phone: primaryTenant.tenant.phone,
              },
              context: {
                tenantName: primaryTenant.tenant.firstName,
                addressLine1: inspection.property.addressLine1,
                unitName: inspection.unit.name,
              },
              propertyId,
              idempotencyKey: `inspection-auto-finalized:${inspection.id}`,
            })
            await dispatchPendingNotifications(new Date(), 100, {
              deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
            })
          }
        } catch (error) {
          console.error(`[inspections] auto-finalize notification failed for ${inspection.id}`, error)
        }
      }
    }

    return { checked: candidates.length, finalized }
  },
})
