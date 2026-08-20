import 'server-only'

import { addBusinessDays, businessDate, businessDaysBetween } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { createTask } from '@/lib/tasks/create.ts'

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

// Walkthrough window (INSP-05, R-074): the self-guided counterpart of the
// window above, for the case that one can't handle - a tenant who never
// starts (or never finishes) the walk at all, so `performedAt` is still
// null. There is nothing to LOCK there: a report with blank rows is not
// evidence of anything (`canFinishInspection`'s own reasoning), so unlike
// the signature window this never force-finalizes. It escalates instead - a
// staff Task, so a person decides whether to chase the tenant or go walk it
// in person - plus a reminder to the tenant. Gated on `selfGuided`, so a
// traditional staff-performed MOVE_IN inspection that simply hasn't been
// walked in person yet is never mistaken for one somebody is waiting on.
//
// SEVEN DAYS, longer than SIGNATURE_WINDOW_DAYS above on purpose - this is
// "walk your whole new home with a phone camera", not "read someone else's
// report and press sign".
const WALKTHROUGH_WINDOW_DAYS = 7

SCHEDULED_JOBS.push({
  type: 'inspection.move_in_overdue',
  localHour: LOCAL_HOUR,
  description:
    'Escalates a self-guided move-in report nobody has walked once the walkthrough window elapses (INSP-05).',
  run: async ({ propertyId, businessDate: today }) => {
    const candidates = await prisma.inspection.findMany({
      where: {
        propertyId,
        type: 'MOVE_IN',
        selfGuided: true,
        performedAt: null,
        lockedAt: null,
        leaseId: { not: null },
      },
      select: {
        id: true,
        leaseId: true,
        createdAt: true,
        unitId: true,
        property: { select: { addressLine1: true, timezone: true } },
        unit: { select: { name: true } },
      },
    })

    let escalated = 0
    for (const inspection of candidates) {
      const createdOn = businessDate(inspection.createdAt, inspection.property.timezone)
      const dueOn = addBusinessDays(createdOn, WALKTHROUGH_WINDOW_DAYS)
      if (businessDaysBetween(dueOn, today) < 0) continue

      // Idempotent per inspection, not per day the job runs past due: the
      // Task's own unique key is (type, subjectId, businessDate), and every
      // run past the deadline computes the SAME `dueOn` - the same
      // "idempotent per lease, not per day" call pre-move-out-scheduling-job.ts
      // already makes, achieved the same way rather than a second query
      // filter.
      const { created } = await createTask(prisma, {
        propertyId,
        type: 'inspection.move_in_overdue',
        subjectType: 'Inspection',
        subjectId: inspection.id,
        businessDate: dueOn,
        priority: 'ROUTINE',
        title: `Move-in walkthrough still not started — ${inspection.unit.name}`,
      })
      if (!created) continue
      escalated++

      try {
        const primaryTenant = await prisma.leaseTenant.findFirst({
          where: { leaseId: inspection.leaseId!, isPrimary: true },
          include: { tenant: { select: { id: true, firstName: true, email: true, phone: true } } },
        })
        if (primaryTenant) {
          const outcomes = await notify({
            category: 'inspection_signature',
            templateKey: 'inspection.move_in_overdue',
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
            idempotencyKey: `inspection-move-in-overdue:${inspection.id}`,
          })
          await dispatchPendingNotifications(new Date(), 100, {
            deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
          })
        }
      } catch (error) {
        console.error(`[inspections] move-in overdue notification failed for ${inspection.id}`, error)
      }
    }

    return { checked: candidates.length, escalated }
  },
})
