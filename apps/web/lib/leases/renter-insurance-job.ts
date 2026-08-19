import 'server-only'

import { businessDaysBetween, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { createTask } from '@/lib/tasks/create.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'

// Renter's-insurance expiry/lapse alerts (LEASE-10, R-067).
//
// 60 days, matching PROP-06's own `INSURANCE_RENEWAL_ALERT_DAYS` convention
// (`packages/core/filing-cabinet/alerts.ts`) for the identical English word
// on a different entity - not imported from there, since that module's own
// header states its functions are scoped to the property-level Mortgage/
// InsurancePolicy/Warranty facts and this is a lease-scoped one instead; the
// comparison itself is a two-line date check, not worth a cross-package
// dependency to share.
const EXPIRING_SOON_DAYS = 60
const LOCAL_HOUR = 5

const IN_FORCE = ['ACTIVE', 'MONTH_TO_MONTH'] as const

SCHEDULED_JOBS.push({
  type: 'lease.renter_insurance_check',
  localHour: LOCAL_HOUR,
  description:
    "Flags a lease's renter's-insurance certificate once it is within 60 days of expiring, or once it has lapsed (LEASE-10).",
  run: async ({ propertyId, businessDate }) => {
    const leases = await prisma.lease.findMany({
      where: { propertyId, status: { in: [...IN_FORCE] } },
      select: {
        id: true,
        unit: { select: { name: true } },
        renterInsurancePolicies: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, expiresOn: true },
        },
      },
    })

    let flagged = 0
    for (const lease of leases) {
      const policy = lease.renterInsurancePolicies[0]
      // No policy on file at all is not this job's business - LEASE-10
      // tracks expiry/lapse of a certificate that EXISTS; whether every
      // lease is required to have one is a separate, unbuilt policy toggle
      // (this item's own PROGRESS entry names the gap).
      if (!policy || !policy.expiresOn) continue

      const daysUntil = businessDaysBetween(businessDate, utcToBusinessDate(policy.expiresOn))
      const type = daysUntil < 0 ? 'renter_insurance_lapsed' : daysUntil <= EXPIRING_SOON_DAYS ? 'renter_insurance_expiring' : null
      if (!type) continue

      const alreadyFlagged = await prisma.task.findFirst({
        where: { type, subjectId: policy.id },
        select: { id: true },
      })
      if (alreadyFlagged) continue

      await createTask(prisma, {
        propertyId,
        type,
        subjectType: 'RenterInsurancePolicy',
        subjectId: policy.id,
        businessDate,
        priority: type === 'renter_insurance_lapsed' ? 'URGENT' : 'ROUTINE',
        title:
          type === 'renter_insurance_lapsed'
            ? `Renter's insurance lapsed - ${lease.unit.name}`
            : `Renter's insurance expiring soon - ${lease.unit.name}`,
      })
      flagged++
    }

    return { checked: leases.length, flagged }
  },
})
