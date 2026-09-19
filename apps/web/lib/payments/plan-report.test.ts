import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, describe, expect, it } from 'vitest'
import { planOfferPatternByTenant } from './plan-report.ts'

// R-231: attributed to whichever tenant the database returned first on a
// joint lease. Now ordered `isPrimary: 'desc'`, same fix as the rent roll
// and the waiver-pattern report (review finding 10).

let propertyId: string
let coTenantId: string
let primaryTenantId: string

afterAll(async () => {
  await prisma.tenant.updateMany({
    where: { id: { in: [coTenantId, primaryTenantId] } },
    data: { active: false },
  })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.$disconnect()
})

describe('planOfferPatternByTenant (R-231, review finding 10)', () => {
  it('attributes a joint lease to the PRIMARY tenant, not whichever row comes back first', async () => {
    const stamp = `plan-joint-${Date.now()}`
    const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
    const property = await prisma.property.create({
      data: {
        legalEntityId: entity.id,
        name: `${stamp}-house`,
        addressLine1: '13 Plan Pl',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
    propertyId = property.id
    const unit = await prisma.unit.create({
      data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
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
    const coTenant = await prisma.tenant.create({
      data: { firstName: 'Zed', lastName: `CoTenant-${randomUUID().slice(0, 6)}` },
    })
    coTenantId = coTenant.id
    const primaryTenant = await prisma.tenant.create({
      data: { firstName: 'Ann', lastName: `Primary-${randomUUID().slice(0, 6)}` },
    })
    primaryTenantId = primaryTenant.id
    // Co-tenant inserted FIRST and is not primary.
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId: coTenantId, isPrimary: false },
    })
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId: primaryTenantId, isPrimary: true },
    })
    await prisma.charge.create({
      data: {
        propertyId,
        leaseId: lease.id,
        type: 'LATE_FEE',
        amountCents: 5_000,
        description: 'late fee',
        dueOn: new Date('2026-02-01'),
      },
    })

    const rows = await planOfferPatternByTenant([propertyId])
    expect(rows).toHaveLength(1)
    expect(rows[0].tenantId).toBe(primaryTenantId)
  }, 20_000)
})
