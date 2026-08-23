import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  hasApprovedAssistanceAnimal,
  leasesWithApprovedAssistanceAnimal,
  requestsForLease,
} from './queries.ts'

// Assistance-animal requests against a real database (RISK-13, R-086).
//
// ==========================================================================
// THE FACT THE MONEY PATH READS, AND THE CONSTRAINTS BEHIND IT.
//
// The fair-housing rules themselves are pure and unit-tested in
// packages/core/accommodations. What only a database can prove is that
// `hasApprovedAssistanceAnimal` answers the question the charge writer
// actually asks - and that the two CHECK constraints refuse the records
// RISK-13 exists to prevent: a decision with no author, date or written
// basis, and an approval that does not say which animal.
// ==========================================================================

let entityId: string
let propertyId: string
let staffId: string
const leaseIds: string[] = []
const tenantIds: string[] = []

beforeAll(async () => {
  const stamp = `accom-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '4 Accommodation Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const staff = await prisma.staffUser.create({
    data: { email: `accom-${randomUUID()}@example.test`, name: 'Accommodation Reviewer' },
  })
  staffId = staff.id
})

afterAll(async () => {
  // AccommodationRequest points at StaffUser and Tenant with Restrict, so
  // nothing is deleted — the roots are retired.
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedTenancy() {
  const stamp = randomUUID().slice(0, 8)
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Sam', lastName: `Accom-${stamp}` },
  })
  tenantIds.push(tenant.id)
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
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  return { leaseId: lease.id, tenantId: tenant.id }
}

async function request(
  leaseId: string,
  tenantId: string,
  status: 'RECEIVED' | 'APPROVED' | 'DENIED',
) {
  const decided =
    status === 'RECEIVED'
      ? {}
      : {
          decidedOn: new Date('2026-08-06T00:00:00.000Z'),
          decidedByStaffId: staffId,
          determinationText:
            status === 'APPROVED'
              ? 'Approved as an assistance animal under the FHA; no pet charges apply.'
              : 'Denied: no disability-related need was established after documentation was lawfully requested.',
          ...(status === 'APPROVED' ? { animalDescription: 'Bella, a labrador retriever' } : {}),
        }

  return prisma.accommodationRequest.create({
    data: {
      propertyId,
      leaseId,
      tenantId,
      kind: 'ASSISTANCE_ANIMAL',
      status,
      requestText: 'Asked to keep an emotional-support dog in the home.',
      receivedOn: new Date('2026-08-01T00:00:00.000Z'),
      ...decided,
    },
  })
}

describe('hasApprovedAssistanceAnimal — the fact the charge writer reads', () => {
  it('is false with nothing on file', async () => {
    const { leaseId } = await seedTenancy()
    expect(await hasApprovedAssistanceAnimal(leaseId)).toBe(false)
  })

  it('is false while a request is only RECEIVED', async () => {
    // Pending is not approved. Refusing pet rent on an undecided request
    // would let a request nobody has looked at change the billing.
    const { leaseId, tenantId } = await seedTenancy()
    await request(leaseId, tenantId, 'RECEIVED')
    expect(await hasApprovedAssistanceAnimal(leaseId)).toBe(false)
  })

  it('is false when the request was DENIED', async () => {
    const { leaseId, tenantId } = await seedTenancy()
    await request(leaseId, tenantId, 'DENIED')
    expect(await hasApprovedAssistanceAnimal(leaseId)).toBe(false)
  })

  it('is true once one is APPROVED', async () => {
    const { leaseId, tenantId } = await seedTenancy()
    await request(leaseId, tenantId, 'APPROVED')
    expect(await hasApprovedAssistanceAnimal(leaseId)).toBe(true)
  })

  it('stays true when a LATER request on the same tenancy is denied', async () => {
    // A household can ask twice. One approval standing is enough to forbid
    // pet money, and a second refused request must not undo it.
    const { leaseId, tenantId } = await seedTenancy()
    await request(leaseId, tenantId, 'APPROVED')
    await request(leaseId, tenantId, 'DENIED')
    expect(await hasApprovedAssistanceAnimal(leaseId)).toBe(true)
  })
})

describe('leasesWithApprovedAssistanceAnimal', () => {
  it('touches the database not at all for an empty input', async () => {
    expect((await leasesWithApprovedAssistanceAnimal([])).size).toBe(0)
  })

  it('picks out only the approved ones', async () => {
    const approved = await seedTenancy()
    const pending = await seedTenancy()
    await request(approved.leaseId, approved.tenantId, 'APPROVED')
    await request(pending.leaseId, pending.tenantId, 'RECEIVED')

    const found = await leasesWithApprovedAssistanceAnimal([approved.leaseId, pending.leaseId])
    expect(found.has(approved.leaseId)).toBe(true)
    expect(found.has(pending.leaseId)).toBe(false)
  })
})

describe('the database refuses an indefensible record', () => {
  it('will not store a decision with no author, date or written basis', async () => {
    const { leaseId, tenantId } = await seedTenancy()
    await expect(
      prisma.accommodationRequest.create({
        data: {
          propertyId,
          leaseId,
          tenantId,
          kind: 'ASSISTANCE_ANIMAL',
          status: 'DENIED',
          requestText: 'Asked to keep a support dog.',
          receivedOn: new Date('2026-08-01T00:00:00.000Z'),
          animalDescription: 'A dog',
        },
      }),
    ).rejects.toThrow()
  })

  it('will not store an approval that does not say which animal', async () => {
    const { leaseId, tenantId } = await seedTenancy()
    await expect(
      prisma.accommodationRequest.create({
        data: {
          propertyId,
          leaseId,
          tenantId,
          kind: 'ASSISTANCE_ANIMAL',
          status: 'APPROVED',
          requestText: 'Asked to keep a support dog.',
          receivedOn: new Date('2026-08-01T00:00:00.000Z'),
          decidedOn: new Date('2026-08-05T00:00:00.000Z'),
          decidedByStaffId: staffId,
          determinationText: 'Approved under the FHA; no pet charges apply to this animal.',
        },
      }),
    ).rejects.toThrow()
  })
})

describe('requestsForLease', () => {
  it('reads the date-only columns without a timezone touching them', async () => {
    // America/Chicago, and `@db.Date` comes back as UTC midnight — reading
    // it through the zone reports the day before, which would understate the
    // response clock by a day on every request.
    const { leaseId, tenantId } = await seedTenancy()
    await request(leaseId, tenantId, 'APPROVED')
    const [row] = await requestsForLease(leaseId)
    expect(row!.receivedOn).toBe('2026-08-01')
    expect(row!.decidedOn).toBe('2026-08-06')
  })
})
