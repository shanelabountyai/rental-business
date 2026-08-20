import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { draftPunchListFromInspection } from './punch-list.ts'

const CHICAGO = 'America/Chicago'
const ACTOR = { type: 'SYSTEM' as const, ref: 'test' }

let entityId: string
const propertyIds: string[] = []
const unitIds: string[] = []
const leaseIds: string[] = []
const projectIds: string[] = []
const inspectionIds: string[] = []

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `Punch List LLC-${Date.now()}`, type: 'LLC' },
  })
  entityId = entity.id
})

afterEach(async () => {
  await prisma.workOrder.deleteMany({ where: { unitId: { in: unitIds } } })
  await prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: inspectionIds } } })
  await prisma.inspection.deleteMany({ where: { id: { in: inspectionIds } } })
  await prisma.turnoverProject.deleteMany({ where: { id: { in: projectIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  // Deactivate, not delete - this test's own `turnover.punch_list_drafted`
  // audit entries carry a real FK to the property, and AuditLog is
  // append-only (CLAUDE.md's own "test cleanup cannot delete a row an
  // append-only table references").
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  inspectionIds.length = 0
  projectIds.length = 0
  leaseIds.length = 0
  unitIds.length = 0
  propertyIds.length = 0
})

afterAll(async () => {
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedMoveOut(withProject: boolean) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `Punch House-${unique}`,
      addressLine1: '1 Punch St',
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
      status: 'ENDED',
      startsOn: new Date('2025-01-01'),
      endsOn: new Date('2026-06-30'),
      rentCents: 150_000,
      moveOutAt: new Date('2026-06-30T18:00:00Z'),
    },
  })
  leaseIds.push(lease.id)
  if (withProject) {
    const project = await prisma.turnoverProject.create({
      data: { propertyId: property.id, unitId: unit.id, leaseId: lease.id },
    })
    projectIds.push(project.id)
  }
  const inspection = await prisma.inspection.create({
    data: { propertyId: property.id, unitId: unit.id, leaseId: lease.id, type: 'MOVE_OUT' },
  })
  inspectionIds.push(inspection.id)
  return { property, unit, lease, inspection }
}

describe('draftPunchListFromInspection', () => {
  it('creates one work order per fixable finding, filed against the project', async () => {
    const { property, unit, lease, inspection } = await seedMoveOut(true)

    const count = await prisma.$transaction((tx) =>
      draftPunchListFromInspection(
        tx,
        { id: inspection.id, propertyId: property.id, unitId: unit.id, leaseId: lease.id, type: 'MOVE_OUT' },
        [
          { room: 'Kitchen', item: 'Countertop', condition: 'DAMAGED', notes: 'Cracked near sink' },
          { room: 'Living room', item: 'Carpet', condition: 'GOOD', notes: null },
          { room: 'Bath', item: 'Vanity', condition: 'MISSING', notes: null },
        ],
        ACTOR,
      ),
    )
    expect(count).toBe(2)

    const project = await prisma.turnoverProject.findUniqueOrThrow({ where: { leaseId: lease.id } })
    const workOrders = await prisma.workOrder.findMany({ where: { turnoverProjectId: project.id } })
    expect(workOrders).toHaveLength(2)
    expect(workOrders.map((w) => w.scope).join(' ')).toContain('Cracked near sink')
    expect(workOrders.every((w) => w.turnoverStage === null)).toBe(true)

    const entry = await prisma.auditLog.findFirst({ where: { action: 'turnover.punch_list_drafted' } })
    expect(entry).not.toBeNull()
    expect(entry?.after).toMatchObject({ count: 2 })
  })

  it('does nothing for a PRE_MOVE_OUT inspection', async () => {
    const { property, unit, lease, inspection } = await seedMoveOut(true)

    const count = await prisma.$transaction((tx) =>
      draftPunchListFromInspection(
        tx,
        { id: inspection.id, propertyId: property.id, unitId: unit.id, leaseId: lease.id, type: 'PRE_MOVE_OUT' },
        [{ room: 'Kitchen', item: 'Countertop', condition: 'DAMAGED', notes: null }],
        ACTOR,
      ),
    )
    expect(count).toBe(0)
    expect(await prisma.workOrder.count({ where: { unitId: unit.id } })).toBe(0)
  })

  it('does nothing when the lease has no turnover project yet', async () => {
    const { property, unit, lease, inspection } = await seedMoveOut(false)

    const count = await prisma.$transaction((tx) =>
      draftPunchListFromInspection(
        tx,
        { id: inspection.id, propertyId: property.id, unitId: unit.id, leaseId: lease.id, type: 'MOVE_OUT' },
        [{ room: 'Kitchen', item: 'Countertop', condition: 'DAMAGED', notes: null }],
        ACTOR,
      ),
    )
    expect(count).toBe(0)
    expect(await prisma.workOrder.count({ where: { unitId: unit.id } })).toBe(0)
  })

  it('does nothing when every item is GOOD or better', async () => {
    const { property, unit, lease, inspection } = await seedMoveOut(true)

    const count = await prisma.$transaction((tx) =>
      draftPunchListFromInspection(
        tx,
        { id: inspection.id, propertyId: property.id, unitId: unit.id, leaseId: lease.id, type: 'MOVE_OUT' },
        [{ room: 'Kitchen', item: 'Countertop', condition: 'GOOD', notes: null }],
        ACTOR,
      ),
    )
    expect(count).toBe(0)
  })
})
