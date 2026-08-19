import 'server-only'

import { recordAudit } from '@rental/core/audit'
import { businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { syncLease } from '@/lib/billing/lifecycle.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// The automatic MTM rollover (LEASE-09, R-065): "Month-to-month rollovers
// apply the configured MTM rate automatically." The real, fully-automatic
// path for a fixed term that simply runs out with no renewal in flight - no
// e-sign, because nothing is being AGREED, the tenancy is just continuing on
// the terms the original lease already stated for exactly this case
// (`Lease.mtmRentCents`).
//
// recordAudit straight from packages/core/audit, not the app-layer
// auditAsSystem() wrapper - see auto-make-ready.ts's own header for why a
// background job cannot use the wrapper (it resolves the actor from Auth.js,
// which has no request to resolve against here).
//
// "WITHOUT RENEWAL" IS READ THE SAME NARROW WAY auto-make-ready.ts ALREADY
// READS IT: a successor lease already existing for the unit (any status
// that means "this is going to happen or is happening") means a renewal is
// in flight, and this job leaves the lease alone - the renewal offer or its
// own effective-date cutover (renewal-cutover-job.ts) owns what happens
// next, not an automatic MTM rollover racing it.
const LOCAL_HOUR = 4
const COUNTS_AS_RENEWAL_IN_FLIGHT = ['DRAFT', 'PENDING_SIGNATURE', 'ACTIVE', 'MONTH_TO_MONTH'] as const

SCHEDULED_JOBS.push({
  type: 'lease.mtm_rollover',
  localHour: LOCAL_HOUR,
  description:
    'Rolls a fixed-term lease to MONTH_TO_MONTH at its configured MTM rate once its term ends with no renewal in flight (LEASE-09).',
  run: async ({ propertyId, businessDate }) => {
    const asOf = businessDateToUtc(businessDate)

    const candidates = await prisma.lease.findMany({
      where: { propertyId, status: 'ACTIVE', endsOn: { not: null, lt: asOf } },
      select: {
        id: true,
        unitId: true,
        rentCents: true,
        mtmRentCents: true,
        endsOn: true,
        property: { select: { addressLine1: true, timezone: true } },
        unit: { select: { name: true } },
        leaseTenants: {
          where: { isPrimary: true },
          take: 1,
          include: { tenant: { select: { id: true, firstName: true, email: true, phone: true } } },
        },
      },
    })

    let rolled = 0
    for (const lease of candidates) {
      const successor = await prisma.lease.findFirst({
        where: {
          unitId: lease.unitId,
          id: { not: lease.id },
          status: { in: [...COUNTS_AS_RENEWAL_IN_FLIGHT] },
          startsOn: { gte: lease.endsOn! },
        },
        select: { id: true },
      })
      if (successor) continue

      const newRentCents = lease.mtmRentCents ?? lease.rentCents

      await prisma.$transaction(async (tx) => {
        await tx.lease.update({
          where: { id: lease.id },
          data: {
            status: 'MONTH_TO_MONTH',
            isMonthToMonth: true,
            rentCents: newRentCents,
            // Clears the stale term date rather than leaving one behind -
            // expiry.ts's own header states this is the whole reason
            // `endsOn` is nullable on an MTM row: a rolling tenancy is not
            // "approaching a term".
            endsOn: null,
          },
        })
        await recordAudit(tx, {
          actor: { type: 'SYSTEM', ref: 'lease.mtm_rollover' },
          action: 'lease.rolled_to_month_to_month',
          entityType: 'Lease',
          entityId: lease.id,
          propertyId,
          before: { status: 'ACTIVE', rentCents: lease.rentCents, endsOn: lease.endsOn!.toISOString() },
          after: { status: 'MONTH_TO_MONTH', rentCents: newRentCents, endsOn: null },
        })
      })

      // Billing follows the tenancy (D-11) - AFTER the commit, same posture
      // every other status-driven billing call in this codebase takes.
      await syncLease(lease.id).catch((error: unknown) => {
        console.error(`[lease] billing sync failed after MTM rollover on ${lease.id}`, error)
      })

      const tenant = lease.leaseTenants[0]?.tenant
      if (tenant) {
        try {
          const outcomes = await notify({
            category: 'lease_renewal',
            templateKey: 'lease.mtm_rollover',
            recipient: { type: 'TENANT', id: tenant.id, email: tenant.email, phone: tenant.phone },
            context: {
              tenantName: tenant.firstName,
              addressLine1: lease.property.addressLine1,
              unitName: lease.unit.name,
              rentCents: newRentCents,
            },
            propertyId,
            idempotencyKey: `lease-mtm-rollover:${lease.id}`,
          })
          await dispatchPendingNotifications(new Date(), 100, {
            deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
          })
        } catch (error) {
          console.error(`[lease] MTM rollover notification failed for ${lease.id}`, error)
        }
      }

      rolled++
    }

    return { checked: candidates.length, rolled }
  },
})
