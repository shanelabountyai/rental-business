import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordMoveInFromWalk } from './move-in.ts'

// R-172. The writer `Lease.moveInAt` never had. Exercised directly rather
// than through `finishInspection`, which needs a staff session - the e2e
// walk in e2e/inspections.spec.ts is what proves the two are wired.

let entityId: string
let propertyId: string
let unitId: string

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `Move-In Writer LLC-${Date.now()}`, type: 'LLC' },
  })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `Move-In Writer House-${Date.now()}`,
      addressLine1: '1 Handover St',
      city: 'Anytown',
      state: 'XY',
      postalCode: '00000',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({ data: { propertyId, name: 'U-1' } })
  unitId = unit.id
})

afterAll(async () => {
  await prisma.lease.deleteMany({ where: { propertyId } })
  await prisma.unit.deleteMany({ where: { propertyId } })
  await prisma.property.deleteMany({ where: { id: propertyId } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedLease(moveInAt: Date | null) {
  return prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-07-01'),
      rentCents: 150_000,
      moveInAt,
    },
  })
}

describe('recordMoveInFromWalk', () => {
  const walkedAt = new Date('2026-07-08T16:00:00Z')

  it('records the handover when a MOVE_IN walk finishes', async () => {
    const lease = await seedLease(null)
    await recordMoveInFromWalk(prisma, { type: 'MOVE_IN', leaseId: lease.id }, walkedAt)
    expect((await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).moveInAt).toEqual(walkedAt)
  })

  it('leaves an already-recorded handover alone - first writer wins', async () => {
    const recorded = new Date('2026-07-02T14:00:00Z')
    const lease = await seedLease(recorded)
    await recordMoveInFromWalk(prisma, { type: 'MOVE_IN', leaseId: lease.id }, walkedAt)
    expect((await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).moveInAt).toEqual(recorded)
  })

  it('ignores every other kind of walk', async () => {
    const lease = await seedLease(null)
    await recordMoveInFromWalk(prisma, { type: 'MOVE_OUT', leaseId: lease.id }, walkedAt)
    await recordMoveInFromWalk(prisma, { type: 'PERIODIC', leaseId: lease.id }, walkedAt)
    expect((await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).moveInAt).toBeNull()
  })

  it('is a no-op for a walk attached to no lease', async () => {
    await expect(
      recordMoveInFromWalk(prisma, { type: 'MOVE_IN', leaseId: null }, walkedAt),
    ).resolves.toBeUndefined()
  })
})
