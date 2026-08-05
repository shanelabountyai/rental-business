// db:seed:demo - the walking-skeleton demo data (PRD §8, R-013): something
// realistic to look at, not the reference rows seed.mts maintains for every
// environment to function at all.
//
//   npm run db:seed:demo [-- --reset]
//
// Idempotent by default: if the first demo legal entity already exists, this
// no-ops rather than duplicating rows on a second run. `--reset` deletes
// every row this script owns (identified by the two fixed entity names
// below, walking child tables in FK order) and reseeds from scratch - the
// convenient path while iterating on what the demo data should look like.
//
// A caveat that bit R-014 once already: `reset()` finds rows by the CURRENT
// ENTITY_NAMES, so changing one of those names and running `--reset` in the
// same breath does not clean up the old-named rows - it leaves them orphaned
// and creates a second, fresh set under the new name. Renaming an entity
// here means deleting the stale one by hand once, the same way that first
// rename was cleaned up.
//
// Dates are computed relative to when the script runs, not hardcoded: the
// whole point of "late", "in-notice" and "moving out" tenants is that they
// stay late, in-notice and moving out whenever someone actually runs this,
// months from now, not just on the day this was written.
//
// No AuditLog entries - matches seed.mts's own reference-data rows, which
// are not real user actions either. That also means `--reset` can do plain
// deletes: nothing here is made undeletable by the append-only trigger the
// way an audited row would be (see docs/PROGRESS.md's R-008/R-009/R-010/R-011
// entries for that lesson learned the hard way elsewhere).

import { prisma } from '../index.ts'

// Deliberately avoid generic UI words in these names ("Properties", nav
// section labels, unit-status words) - an unscoped e2e locator elsewhere
// substring-matching this data is exactly the kind of collision R-014 found
// and fixed in shell.spec.ts and units.spec.ts; a boring name here is cheap
// insurance against the next one nobody has written yet.
const ENTITY_NAMES = ['Bluebonnet Holdings LLC', 'Sunshine Coast Holdings LLC']

function daysFrom(offset: number): Date {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + offset)
  return date
}

async function reset() {
  const entities = await prisma.legalEntity.findMany({
    where: { name: { in: ENTITY_NAMES } },
    select: { id: true },
  })
  const entityIds = entities.map((e) => e.id)
  if (entityIds.length === 0) return

  const properties = await prisma.property.findMany({
    where: { legalEntityId: { in: entityIds } },
    select: { id: true },
  })
  const propertyIds = properties.map((p) => p.id)

  const leases = await prisma.lease.findMany({
    where: { propertyId: { in: propertyIds } },
    select: { id: true },
  })
  const leaseIds = leases.map((l) => l.id)

  const tenantIds = (
    await prisma.leaseTenant.findMany({
      where: { leaseId: { in: leaseIds } },
      select: { tenantId: true },
    })
  ).map((lt) => lt.tenantId)

  await prisma.charge.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } })
  await prisma.legalEntity.deleteMany({ where: { id: { in: entityIds } } })

  console.info('Reset: removed previous demo data.')
}

interface UnitPlan {
  name: string
  status: 'OCCUPIED' | 'VACANT' | 'MAKE_READY' | 'DOWN'
  marketRentCents: number
  bedrooms: number
  bathrooms: number
  /// Present only for units that get an occupying tenant.
  tenant?: {
    firstName: string
    lastName: string
    email: string
    /// E.164, because that is the only form inbound SMS routing compares
    /// against (R-017). A demo tenant with a prettily-formatted number would
    /// silently never match an inbound text.
    phone: string
    lifecycle: string
    lease: {
      status: 'ACTIVE' | 'MONTH_TO_MONTH'
      startsOn: Date
      endsOn?: Date
      rentCents: number
      depositCents: number
      isMonthToMonth?: boolean
      moveOutAt?: Date
      noticeGivenAt?: Date
      /// A single overdue rent charge, standing in for "late" - no Payment
      /// or LedgerEntry rows here (D-11: those are a Stripe-webhook
      /// projection, never written directly). A Charge is fair game - it is
      /// core-computed and pushed TO Stripe, not sourced FROM it (D-12).
      overdueCharge?: boolean
    }
  }
}

interface PropertyPlan {
  legalEntityIndex: 0 | 1
  name: string
  addressLine1: string
  city: string
  state: string
  postalCode: string
  timezone: string
  propertyType:
    | 'SINGLE_FAMILY'
    | 'DUPLEX'
    | 'TOWNHOUSE'
    | 'CONDO'
  acquiredOn?: Date
  units: UnitPlan[]
}

function buildPlan(): PropertyPlan[] {
  return [
    {
      legalEntityIndex: 0,
      name: 'Bluebonnet Lane House',
      addressLine1: '122 Bluebonnet Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78704',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      units: [
        {
          name: 'Main house',
          status: 'OCCUPIED',
          marketRentCents: 220000,
          bedrooms: 3,
          bathrooms: 2,
          tenant: {
            firstName: 'Maria',
            lastName: 'Alvarez',
            email: 'maria.alvarez@example.test',
            phone: '+15125550142',
            lifecycle: 'current',
            lease: {
              status: 'ACTIVE',
              startsOn: daysFrom(-240),
              endsOn: daysFrom(125),
              rentCents: 220000,
              depositCents: 220000,
            },
          },
        },
      ],
    },
    {
      legalEntityIndex: 0,
      name: 'Riverside Court Duplex',
      addressLine1: '48 Riverside Ct',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'DUPLEX',
      units: [
        {
          name: 'Unit A',
          status: 'OCCUPIED',
          marketRentCents: 165000,
          bedrooms: 2,
          bathrooms: 1,
          tenant: {
            firstName: 'Derrick',
            lastName: 'Holt',
            email: 'derrick.holt@example.test',
            phone: '+15125550178',
            lifecycle: 'late',
            lease: {
              status: 'ACTIVE',
              startsOn: daysFrom(-420),
              endsOn: daysFrom(35),
              rentCents: 165000,
              depositCents: 165000,
              overdueCharge: true,
            },
          },
        },
        {
          name: 'Unit B',
          status: 'OCCUPIED',
          marketRentCents: 160000,
          bedrooms: 2,
          bathrooms: 1,
          tenant: {
            firstName: 'Priya',
            lastName: 'Nair',
            email: 'priya.nair@example.test',
            phone: '+17135550119',
            lifecycle: 'in-notice',
            lease: {
              status: 'ACTIVE',
              startsOn: daysFrom(-380),
              endsOn: daysFrom(20),
              rentCents: 160000,
              depositCents: 160000,
              noticeGivenAt: daysFrom(-10),
              moveOutAt: daysFrom(20),
            },
          },
        },
      ],
    },
    {
      legalEntityIndex: 0,
      // Still has a real ADU unit below (per this item's own "units incl. an
      // ADU" requirement) - just not spelled out in the property's own name,
      // for the same collision reason as the entity names above.
      name: 'Magnolia Drive House',
      addressLine1: '310 Magnolia Dr',
      city: 'San Antonio',
      state: 'TX',
      postalCode: '78201',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      units: [
        {
          name: 'Main house',
          status: 'OCCUPIED',
          marketRentCents: 195000,
          bedrooms: 3,
          bathrooms: 2,
          tenant: {
            firstName: 'Wanda',
            lastName: 'Combs',
            email: 'wanda.combs@example.test',
            phone: '+19045550163',
            lifecycle: 'moving-out',
            lease: {
              status: 'ACTIVE',
              startsOn: daysFrom(-365),
              endsOn: daysFrom(5),
              rentCents: 195000,
              depositCents: 195000,
              moveOutAt: daysFrom(5),
            },
          },
        },
        {
          name: 'ADU',
          status: 'VACANT',
          marketRentCents: 120000,
          bedrooms: 1,
          bathrooms: 1,
        },
      ],
    },
    {
      legalEntityIndex: 0,
      name: 'Sunset Boulevard Townhouse',
      addressLine1: '77 Sunset Blvd',
      city: 'Dallas',
      state: 'TX',
      postalCode: '75201',
      timezone: 'America/Chicago',
      propertyType: 'TOWNHOUSE',
      acquiredOn: daysFrom(-45),
      units: [
        {
          name: 'Main unit',
          status: 'OCCUPIED',
          marketRentCents: 210000,
          bedrooms: 3,
          bathrooms: 2.5,
          tenant: {
            firstName: 'Grant',
            lastName: 'Okafor',
            email: 'grant.okafor@example.test',
            phone: '+19045550187',
            lifecycle: 'inherited-at-acquisition',
            lease: {
              // Started long before this property's acquiredOn above -
              // a tenancy the current owner inherited at closing, still
              // going, now month-to-month.
              status: 'MONTH_TO_MONTH',
              startsOn: daysFrom(-730),
              rentCents: 200000,
              depositCents: 200000,
              isMonthToMonth: true,
            },
          },
        },
      ],
    },
    {
      legalEntityIndex: 1,
      name: 'Palm Avenue House',
      addressLine1: '500 Palm Ave',
      city: 'Tampa',
      state: 'FL',
      postalCode: '33602',
      timezone: 'America/New_York',
      propertyType: 'SINGLE_FAMILY',
      units: [
        {
          name: 'Main house',
          status: 'MAKE_READY',
          marketRentCents: 230000,
          bedrooms: 3,
          bathrooms: 2,
        },
      ],
    },
    {
      legalEntityIndex: 1,
      name: 'Coral Way Condo',
      addressLine1: '14 Coral Way',
      city: 'Orlando',
      state: 'FL',
      postalCode: '32801',
      timezone: 'America/New_York',
      propertyType: 'CONDO',
      units: [
        {
          name: 'Unit 1',
          status: 'DOWN',
          marketRentCents: 175000,
          bedrooms: 2,
          bathrooms: 2,
        },
      ],
    },
  ]
}

async function seedDemoData() {
  const existing = await prisma.legalEntity.findFirst({
    where: { name: ENTITY_NAMES[0] },
  })
  if (existing) {
    console.info('Demo data already seeded - pass --reset to rebuild it.')
    return
  }

  const entities = await Promise.all(
    ENTITY_NAMES.map((name) => prisma.legalEntity.create({ data: { name, type: 'LLC' } })),
  )

  let propertyCount = 0
  let unitCount = 0
  let tenantCount = 0

  for (const plan of buildPlan()) {
    const property = await prisma.property.create({
      data: {
        legalEntityId: entities[plan.legalEntityIndex]!.id,
        name: plan.name,
        addressLine1: plan.addressLine1,
        city: plan.city,
        state: plan.state,
        postalCode: plan.postalCode,
        timezone: plan.timezone,
        propertyType: plan.propertyType,
        acquiredOn: plan.acquiredOn,
      },
    })
    propertyCount++

    for (const unitPlan of plan.units) {
      const unit = await prisma.unit.create({
        data: {
          propertyId: property.id,
          name: unitPlan.name,
          status: unitPlan.status,
          marketRentCents: unitPlan.marketRentCents,
          bedrooms: unitPlan.bedrooms,
          bathrooms: unitPlan.bathrooms,
        },
      })
      unitCount++

      if (!unitPlan.tenant) continue
      const { tenant: tenantPlan } = unitPlan

      const tenant = await prisma.tenant.create({
        data: {
          firstName: tenantPlan.firstName,
          lastName: tenantPlan.lastName,
          email: tenantPlan.email,
          phone: tenantPlan.phone,
          notes: `Demo tenant - lifecycle state: ${tenantPlan.lifecycle}.`,
        },
      })
      tenantCount++

      const lease = await prisma.lease.create({
        data: {
          propertyId: property.id,
          unitId: unit.id,
          status: tenantPlan.lease.status,
          startsOn: tenantPlan.lease.startsOn,
          endsOn: tenantPlan.lease.endsOn,
          rentCents: tenantPlan.lease.rentCents,
          depositCents: tenantPlan.lease.depositCents,
          isMonthToMonth: tenantPlan.lease.isMonthToMonth ?? false,
          moveOutAt: tenantPlan.lease.moveOutAt,
          noticeGivenAt: tenantPlan.lease.noticeGivenAt,
        },
      })

      await prisma.leaseTenant.create({
        data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
      })

      if (tenantPlan.lease.overdueCharge) {
        await prisma.charge.create({
          data: {
            propertyId: property.id,
            leaseId: lease.id,
            type: 'RENT',
            amountCents: tenantPlan.lease.rentCents,
            description: 'Monthly rent',
            dueOn: daysFrom(-20),
          },
        })
      }
    }
  }

  console.info(
    `Seeded demo data: ${entities.length} legal entities, ${propertyCount} properties, ${unitCount} units, ${tenantCount} tenants.`,
  )
}

async function main() {
  if (process.argv.includes('--reset')) await reset()
  await seedDemoData()
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
