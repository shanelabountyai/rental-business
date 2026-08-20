import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startTurnoverProjectForLease } from './start.ts'

const CHICAGO = 'America/Chicago'

let entityId: string
const propertyIds: string[] = []
const unitIds: string[] = []
const leaseIds: string[] = []
const projectIds: string[] = []

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `Turnover Start LLC-${Date.now()}`, type: 'LLC' },
  })
  entityId = entity.id
})

afterEach(async () => {
  await prisma.turnoverProject.deleteMany({ where: { id: { in: projectIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } })
  projectIds.length = 0
  leaseIds.length = 0
  unitIds.length = 0
  propertyIds.length = 0
})

afterAll(async () => {
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedLease(moveOutAt: Date | null) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `Turnover House-${unique}`,
      addressLine1: '1 Turn St',
      city: 'Anytown',
      state: 'XY',
      postalCode: '00000',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({ data: { propertyId: property.id, name: `U-${unique}` } })
  unitIds.push(unit.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: moveOutAt ? 'ENDED' : 'ACTIVE',
      startsOn: new Date('2025-01-01'),
      endsOn: new Date('2026-06-30'),
      rentCents: 150_000,
      moveOutAt,
    },
  })
  leaseIds.push(lease.id)
  return { property, unit, lease }
}

describe('startTurnoverProjectForLease', () => {
  it('creates the project once the lease has a moveOutAt', async () => {
    const { unit, lease } = await seedLease(new Date('2026-06-30T18:00:00Z'))

    const project = await startTurnoverProjectForLease(lease.id)
    expect(project).not.toBeNull()
    projectIds.push(project!.id)
    expect(project!.unitId).toBe(unit.id)
    expect(project!.rentReadyAt).toBeNull()
  })

  it('returns null and creates nothing when moveOutAt is not set yet', async () => {
    const { lease } = await seedLease(null)

    const project = await startTurnoverProjectForLease(lease.id)
    expect(project).toBeNull()

    const count = await prisma.turnoverProject.count({ where: { leaseId: lease.id } })
    expect(count).toBe(0)
  })

  it('is idempotent - a second call returns the same row, not a duplicate', async () => {
    const { lease } = await seedLease(new Date('2026-06-30T18:00:00Z'))

    const first = await startTurnoverProjectForLease(lease.id)
    projectIds.push(first!.id)
    const second = await startTurnoverProjectForLease(lease.id)

    expect(second!.id).toBe(first!.id)
    const count = await prisma.turnoverProject.count({ where: { leaseId: lease.id } })
    expect(count).toBe(1)
  })
})
