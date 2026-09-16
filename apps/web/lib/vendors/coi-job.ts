import 'server-only'

import { businessDaysBetween, utcToBusinessDate } from '@rental/core/scheduling'
import { vendorCoversProperty } from '@rental/core/vendors'
import { prisma } from '@rental/db'
import { alreadyFlagged } from '@/lib/tasks/already-flagged.ts'
import { createTask } from '@/lib/tasks/create.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'

// Vendor certificate-of-insurance expiry/lapse alerts (MAINT-11, R-214) - the
// vendor-side twin of `lease.renter_insurance_check`. Before this, a COI that
// lapsed in February was found in November by somebody opening the vendor
// record, and an uninsured roofer's fall lands on the owner.
//
// A vendor with NO certificate on file is not this job's business, exactly as
// a lease with no policy is not the renter job's: that gap is permanent rather
// than a date passing, so it is shown where the decision is made - "no COI" on
// `/vendors` and in the assign dropdown, and at dispatch - instead of a Task
// that would re-raise weekly for every handyman who will never carry one.
//
// `Vendor` has no `propertyId` and `Task` requires one, so the Task lands on
// the first property in the vendor's territory whose job runs that day;
// `alreadyFlagged` matches on subjectId alone, so the other properties do not
// raise a second.
// ponytail: a PM scoped away from that property does not see the Task; give
// Task a nullable propertyId if vendor flags ever need portfolio-wide routing.

/// 30 days, not the renter job's 60: a vendor's certificate is one email to
/// their agent, not a tenant shopping for a policy.
const EXPIRING_SOON_DAYS = 30
const LOCAL_HOUR = 5

SCHEDULED_JOBS.push({
  type: 'vendor.coi_check',
  localHour: LOCAL_HOUR,
  description:
    "Flags a vendor's certificate of insurance once it is within 30 days of expiring, or once it has lapsed (MAINT-11).",
  run: async ({ propertyId, businessDate }) => {
    const [property, vendors] = await Promise.all([
      prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { city: true, postalCode: true } }),
      prisma.vendor.findMany({
        where: { active: true, coiExpiresOn: { not: null } },
        select: { id: true, name: true, serviceAreas: true, coiExpiresOn: true },
      }),
    ])

    let flagged = 0
    for (const vendor of vendors) {
      if (!vendorCoversProperty(vendor, property)) continue
      const daysUntil = businessDaysBetween(businessDate, utcToBusinessDate(vendor.coiExpiresOn!))
      const type = daysUntil < 0 ? 'vendor_coi_lapsed' : daysUntil <= EXPIRING_SOON_DAYS ? 'vendor_coi_expiring' : null
      if (!type) continue
      if (await alreadyFlagged(type, vendor.id, businessDate)) continue

      const { created } = await createTask(prisma, {
        propertyId,
        type,
        subjectType: 'Vendor',
        subjectId: vendor.id,
        businessDate,
        priority: type === 'vendor_coi_lapsed' ? 'URGENT' : 'ROUTINE',
        title:
          type === 'vendor_coi_lapsed'
            ? `Vendor insurance lapsed - ${vendor.name}`
            : `Vendor insurance expiring soon - ${vendor.name}`,
      })
      if (created) flagged++
    }

    return { checked: vendors.length, flagged }
  },
})
