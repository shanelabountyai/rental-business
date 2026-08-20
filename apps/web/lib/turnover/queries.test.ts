import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getTurnoverForUnit } from './queries.ts'

const CHICAGO = 'America/Chicago'

let entityId: string
const propertyIds: string[] = []
const unitIds: string[] = []
const leaseIds: string[] = []
const projectIds: string[] = []
const vendorIds: string[] = []

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `Turnover Query LLC-${Date.now()}`, type: 'LLC' },
  })
  entityId = entity.id
})

afterEach(async () => {
  await prisma.workOrder.deleteMany({ where: { unitId: { in: unitIds } } })
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await prisma.turnoverProject.deleteMany({ where: { id: { in: projectIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } })
  vendorIds.length = 0
  projectIds.length = 0
  leaseIds.length = 0
  unitIds.length = 0
  propertyIds.length = 0
})

afterAll(async () => {
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedProperty() {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `Turnover Query House-${unique}`,
      addressLine1: '1 Query St',
      city: 'Anytown',
      state: 'XY',
      postalCode: '00000',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return property
}

async function seedLease(propertyId: string, unitId: string, data: Record<string, unknown>) {
  const lease = await prisma.lease.create({
    data: { propertyId, unitId, status: 'ENDED', startsOn: new Date('2025-01-01'), rentCents: 150_000, ...data },
  })
  leaseIds.push(lease.id)
  return lease
}

describe('getTurnoverForUnit', () => {
  it('returns null when the unit has no turnover project', async () => {
    const property = await seedProperty()
    const unit = await prisma.unit.create({ data: { propertyId: property.id, name: 'U-none' } })
    unitIds.push(unit.id)

    expect(await getTurnoverForUnit(unit.id, CHICAGO, new Date('2026-07-10T12:00:00Z'))).toBeNull()
  })

  it('rolls up cost across the punch list and counts days vacant against "today" while open', async () => {
    const property = await seedProperty()
    const unit = await prisma.unit.create({ data: { propertyId: property.id, name: 'U-open' } })
    unitIds.push(unit.id)
    const lease = await seedLease(property.id, unit.id, {
      endsOn: new Date('2026-06-30'),
      moveOutAt: new Date('2026-06-30T18:00:00Z'),
    })
    const project = await prisma.turnoverProject.create({
      data: { propertyId: property.id, unitId: unit.id, leaseId: lease.id },
    })
    projectIds.push(project.id)
    const vendor = await prisma.vendor.create({ data: { name: 'Ace Painting' } })
    vendorIds.push(vendor.id)
    await prisma.workOrder.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        turnoverProjectId: project.id,
        turnoverStage: 'PAINT',
        priority: 'ROUTINE',
        scope: 'Paint interior',
        vendorId: vendor.id,
        invoiceCents: 45_000,
      },
    })
    await prisma.workOrder.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        turnoverProjectId: project.id,
        turnoverStage: 'CLEAN',
        priority: 'ROUTINE',
        scope: 'Deep clean',
        actualLaborCents: 12_000,
        actualMaterialsCents: 3_000,
      },
    })

    const detail = await getTurnoverForUnit(unit.id, CHICAGO, new Date('2026-07-10T12:00:00Z'))
    expect(detail).not.toBeNull()
    expect(detail!.totalCostCents).toBe(45_000 + 12_000 + 3_000)
    expect(detail!.items).toHaveLength(2)
    expect(detail!.items.find((i) => i.stage === 'PAINT')?.vendorName).toBe('Ace Painting')
    // 2026-06-30 -> 2026-07-10 (asOf, business date in Chicago from a noon UTC instant).
    expect(detail!.daysVacant).toBe(10)
    expect(detail!.daysVacantIsFinal).toBe(false)
  })

  it('closes the clock at the next lease\'s moveInAt once one exists', async () => {
    const property = await seedProperty()
    const unit = await prisma.unit.create({ data: { propertyId: property.id, name: 'U-closed' } })
    unitIds.push(unit.id)
    const lease = await seedLease(property.id, unit.id, {
      endsOn: new Date('2026-06-30'),
      moveOutAt: new Date('2026-06-30T18:00:00Z'),
    })
    const project = await prisma.turnoverProject.create({
      data: { propertyId: property.id, unitId: unit.id, leaseId: lease.id, rentReadyAt: new Date('2026-07-05T12:00:00Z') },
    })
    projectIds.push(project.id)
    await seedLease(property.id, unit.id, {
      status: 'ACTIVE',
      startsOn: new Date('2026-07-08'),
      endsOn: null,
      moveInAt: new Date('2026-07-08T16:00:00Z'),
    })

    const detail = await getTurnoverForUnit(unit.id, CHICAGO, new Date('2026-08-01T12:00:00Z'))
    expect(detail).not.toBeNull()
    // 2026-06-30 -> 2026-07-08, not all the way to the "asOf" a month later.
    expect(detail!.daysVacant).toBe(8)
    expect(detail!.daysVacantIsFinal).toBe(true)
    expect(detail!.rentReadyAt).not.toBeNull()
  })
})
