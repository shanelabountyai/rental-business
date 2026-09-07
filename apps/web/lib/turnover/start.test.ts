import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REKEY_SCOPE, startTurnoverProjectForLease } from './start.ts'

const CHICAGO = 'America/Chicago'

let entityId: string
const propertyIds: string[] = []

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `Turnover Start LLC-${Date.now()}`, type: 'LLC' },
  })
  entityId = entity.id
})

// DEACTIVATED, NEVER DELETED (R-176). This function now writes an AuditLog
// row for the re-key work order it opens, and `AuditLog` is append-only by
// trigger with a nullable `propertyId` FK - so deleting the property fires a
// SetNull cascade the trigger refuses, and the whole delete dies. Marking the
// property inactive is also what `notifications.test.ts` reads as "this spec
// has finished" (CLAUDE.md's cleanup-by-ownership rule).
afterAll(async () => {
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
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
  return { property, unit, lease }
}

describe('startTurnoverProjectForLease', () => {
  it('creates the project once the lease has a moveOutAt', async () => {
    const { unit, lease } = await seedLease(new Date('2026-06-30T18:00:00Z'))

    const project = await startTurnoverProjectForLease(lease.id)
    expect(project).not.toBeNull()
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
    const second = await startTurnoverProjectForLease(lease.id)

    expect(second!.id).toBe(first!.id)
    const count = await prisma.turnoverProject.count({ where: { leaseId: lease.id } })
    expect(count).toBe(1)
  })

  // R-176.
  it('opens an urgent re-key work order with the turn', async () => {
    const { lease } = await seedLease(new Date('2026-06-30T18:00:00Z'))

    const project = await startTurnoverProjectForLease(lease.id)

    const rekeys = await prisma.workOrder.findMany({
      where: { turnoverProjectId: project!.id, turnoverStage: 'REKEY' },
    })
    expect(rekeys).toHaveLength(1)
    expect(rekeys[0].scope).toBe(REKEY_SCOPE)
    expect(rekeys[0].priority).toBe('URGENT')
  })

  it('does not open a second re-key on a re-run', async () => {
    const { lease } = await seedLease(new Date('2026-06-30T18:00:00Z'))

    const project = await startTurnoverProjectForLease(lease.id)
    await startTurnoverProjectForLease(lease.id)

    const count = await prisma.workOrder.count({
      where: { turnoverProjectId: project!.id, turnoverStage: 'REKEY' },
    })
    expect(count).toBe(1)
  })
})
