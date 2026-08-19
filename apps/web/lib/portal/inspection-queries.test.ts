import { randomUUID } from 'node:crypto'
import type { TenantScope } from '@rental/core/portal'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTenantInspection, inspectionsAwaitingTenantSignature } from './inspection-queries.ts'

// Reads for a tenant's own inspection review (INSP-01, R-068 phase 2) - the
// write (signInspectionAsTenant) is session-dependent via
// requireTenantWithScope()/audit() and is e2e-only, the same wall every
// other portal query/action pair in this repo draws.

let entityId: string
let propertyId: string
let unitId: string
let leaseId: string
let tenantId: string
const inspectionIds: string[] = []

function scopeFor(leaseIds: string[]): TenantScope {
  return { tenantId, leaseIds, unitIds: [unitId] }
}

beforeAll(async () => {
  const stamp = `tenantinsp-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '20 Review Rd',
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
  unitId = unit.id
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Sam', lastName: `Review-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
  const lease = await prisma.lease.create({
    data: { propertyId, unitId, status: 'ACTIVE', startsOn: new Date('2026-01-01'), rentCents: 150_000 },
  })
  leaseId = lease.id
  await prisma.leaseTenant.create({ data: { leaseId, tenantId, isPrimary: true } })
})

afterAll(async () => {
  await prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: inspectionIds } } })
  await prisma.inspection.deleteMany({ where: { id: { in: inspectionIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId } })
  await prisma.lease.deleteMany({ where: { id: leaseId } })
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

describe('inspectionsAwaitingTenantSignature', () => {
  it('lists a performed, unsigned, unlocked inspection on the tenant\'s own lease', async () => {
    const inspection = await prisma.inspection.create({
      data: { propertyId, unitId, leaseId, type: 'MOVE_IN', performedAt: new Date() },
    })
    inspectionIds.push(inspection.id)

    const list = await inspectionsAwaitingTenantSignature(scopeFor([leaseId]))
    expect(list.map((i) => i.id)).toContain(inspection.id)
  })

  it('excludes an inspection not yet performed', async () => {
    const inspection = await prisma.inspection.create({
      data: { propertyId, unitId, leaseId, type: 'MOVE_IN' },
    })
    inspectionIds.push(inspection.id)

    const list = await inspectionsAwaitingTenantSignature(scopeFor([leaseId]))
    expect(list.map((i) => i.id)).not.toContain(inspection.id)
  })

  it('excludes an inspection already signed', async () => {
    const inspection = await prisma.inspection.create({
      data: {
        propertyId,
        unitId,
        leaseId,
        type: 'MOVE_IN',
        performedAt: new Date(),
        tenantSignedAt: new Date(),
        lockedAt: new Date(),
      },
    })
    inspectionIds.push(inspection.id)

    const list = await inspectionsAwaitingTenantSignature(scopeFor([leaseId]))
    expect(list.map((i) => i.id)).not.toContain(inspection.id)
  })

  it('returns nothing outside the tenant\'s own leases', async () => {
    expect(await inspectionsAwaitingTenantSignature(scopeFor([]))).toEqual([])
  })
})

describe('getTenantInspection', () => {
  it('returns the inspection with its items, on the tenant\'s own lease', async () => {
    const inspection = await prisma.inspection.create({
      data: {
        propertyId,
        unitId,
        leaseId,
        type: 'MOVE_IN',
        items: { create: [{ room: 'Kitchen', item: 'Sink', order: 0, condition: 'GOOD' }] },
      },
    })
    inspectionIds.push(inspection.id)

    const found = await getTenantInspection(inspection.id, scopeFor([leaseId]))
    expect(found?.items).toHaveLength(1)
  })

  it('returns null for an inspection on someone else\'s lease', async () => {
    const inspection = await prisma.inspection.create({
      data: { propertyId, unitId, leaseId, type: 'MOVE_IN' },
    })
    inspectionIds.push(inspection.id)

    expect(await getTenantInspection(inspection.id, scopeFor(['some-other-lease']))).toBeNull()
  })

  it('returns null for an inspection with no lease at all', async () => {
    const inspection = await prisma.inspection.create({
      data: { propertyId, unitId, type: 'PERIODIC' },
    })
    inspectionIds.push(inspection.id)

    expect(await getTenantInspection(inspection.id, scopeFor([leaseId]))).toBeNull()
  })

  it('returns null for an id that does not exist', async () => {
    expect(await getTenantInspection('not-a-real-id', scopeFor([leaseId]))).toBeNull()
  })
})
