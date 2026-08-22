import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { affidavitLookupFor, lookupsForLease } from './queries.ts'

// Which DMDC search the §3931 affidavit is read from (RISK-12, R-085).
//
// ==========================================================================
// THE ONE PIECE OF REAL LOGIC BETWEEN THE TABLE AND THE GATE.
//
// `affidavitReadiness` is pure and unit-tested in packages/core/scra. What
// only a database can prove is which row it gets handed, and that choice is
// not "the newest": a tenancy has one adult per search, the affidavit is
// about a NAMED defendant, and a second tenant's clean certificate must
// never mask the first tenant's active-duty one. Picking the newest row
// would do exactly that, silently, and the resulting affidavit would be
// false.
// ==========================================================================

let entityId: string
let propertyId: string
let staffId: string
const leaseIds: string[] = []
const tenantIds: string[] = []

beforeAll(async () => {
  const stamp = `scra-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '7 Garrison Road',
      city: 'Killeen',
      state: 'TX',
      postalCode: '76541',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const staff = await prisma.staffUser.create({
    data: { email: `scra-${randomUUID()}@example.test`, name: 'Affidavit Clerk' },
  })
  staffId = staff.id
})

afterAll(async () => {
  // ScraLookup points at StaffUser and Tenant with onDelete: Restrict, so
  // nothing is deleted — the roots are retired, the pattern CLAUDE.md names.
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedTenancy(adults: number) {
  const stamp = randomUUID().slice(0, 8)
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  leaseIds.push(lease.id)

  const tenants: string[] = []
  for (let index = 0; index < adults; index += 1) {
    const tenant = await prisma.tenant.create({
      data: { firstName: `Adult${index}`, lastName: `Scra-${stamp}` },
    })
    tenantIds.push(tenant.id)
    tenants.push(tenant.id)
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: index === 0 },
    })
  }
  return { leaseId: lease.id, tenants }
}

async function lookup(
  leaseId: string,
  tenantId: string,
  result: 'IN_SERVICE' | 'NOT_IN_SERVICE' | 'INDETERMINATE',
  searchedOn: string,
) {
  return prisma.scraLookup.create({
    data: {
      leaseId,
      propertyId,
      tenantId,
      result,
      searchedOn: new Date(`${searchedOn}T00:00:00.000Z`),
      recordedByStaffId: staffId,
    },
  })
}

describe('affidavitLookupFor', () => {
  it('is null when nothing has been searched', async () => {
    const { leaseId } = await seedTenancy(1)
    expect(await affidavitLookupFor(leaseId)).toBeNull()
  })

  it('reads the latest search for a single tenant', async () => {
    const { leaseId, tenants } = await seedTenancy(1)
    await lookup(leaseId, tenants[0]!, 'IN_SERVICE', '2026-05-01')
    await lookup(leaseId, tenants[0]!, 'NOT_IN_SERVICE', '2026-08-01')

    // Superseded: the same person, searched again, is no longer serving.
    expect(await affidavitLookupFor(leaseId)).toEqual({
      result: 'not_in_service',
      searchedOn: '2026-08-01',
    })
  })

  it('LETS ONE TENANT’S ACTIVE DUTY OUTRANK ANOTHER’S NEWER CLEAN RESULT', async () => {
    // The failure this function exists to prevent. Newest-row-wins would
    // report `not_in_service` here and the affidavit would be false.
    const { leaseId, tenants } = await seedTenancy(2)
    await lookup(leaseId, tenants[0]!, 'IN_SERVICE', '2026-08-01')
    await lookup(leaseId, tenants[1]!, 'NOT_IN_SERVICE', '2026-08-20')

    expect(await affidavitLookupFor(leaseId)).toEqual({
      result: 'in_service',
      searchedOn: '2026-08-01',
    })
  })

  it('ranks a no-match above a negative, for the same reason', async () => {
    const { leaseId, tenants } = await seedTenancy(2)
    await lookup(leaseId, tenants[0]!, 'INDETERMINATE', '2026-08-01')
    await lookup(leaseId, tenants[1]!, 'NOT_IN_SERVICE', '2026-08-20')

    expect((await affidavitLookupFor(leaseId))?.result).toBe('indeterminate')
  })

  it('measures staleness from the OLDEST row carrying the deciding result', async () => {
    // Two adults, both clean, searched a month apart. The affidavit is only
    // as fresh as its weakest evidence, so the older date is the one
    // staleness is judged against — flattering it with the newer search
    // would let half the tenancy go unverified indefinitely.
    const { leaseId, tenants } = await seedTenancy(2)
    await lookup(leaseId, tenants[0]!, 'NOT_IN_SERVICE', '2026-06-01')
    await lookup(leaseId, tenants[1]!, 'NOT_IN_SERVICE', '2026-08-20')

    expect(await affidavitLookupFor(leaseId)).toEqual({
      result: 'not_in_service',
      searchedOn: '2026-06-01',
    })
  })
})

describe('lookupsForLease', () => {
  it('keeps every search, not just the latest', async () => {
    const { leaseId, tenants } = await seedTenancy(1)
    await lookup(leaseId, tenants[0]!, 'IN_SERVICE', '2026-05-01')
    await lookup(leaseId, tenants[0]!, 'NOT_IN_SERVICE', '2026-08-01')

    const rows = await lookupsForLease(leaseId)
    expect(rows).toHaveLength(2)
    // Newest first, and the superseded one is still there — "what did you
    // know in May" is answerable only from the May row.
    expect(rows.map((row) => row.searchedOn)).toEqual(['2026-08-01', '2026-05-01'])
    expect(rows[1]!.result).toBe('in_service')
  })

  it('reads the date-only column without a timezone touching it', async () => {
    // A `@db.Date` comes back as UTC midnight, and this property is
    // America/Chicago — reading it through the zone would report the day
    // before. The defect R-042 shipped, in a different column.
    const { leaseId, tenants } = await seedTenancy(1)
    await lookup(leaseId, tenants[0]!, 'NOT_IN_SERVICE', '2026-03-01')
    expect((await lookupsForLease(leaseId))[0]!.searchedOn).toBe('2026-03-01')
  })
})

describe('the database refuses a contradictory row', () => {
  it('will not store active-duty dates on a negative certificate', async () => {
    const { leaseId, tenants } = await seedTenancy(1)
    await expect(
      prisma.scraLookup.create({
        data: {
          leaseId,
          propertyId,
          tenantId: tenants[0]!,
          result: 'NOT_IN_SERVICE',
          searchedOn: new Date('2026-08-01T00:00:00.000Z'),
          activeDutyStartOn: new Date('2026-01-01T00:00:00.000Z'),
          recordedByStaffId: staffId,
        },
      }),
    ).rejects.toThrow()
  })
})
