import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { baselineMoveInFor, itemsFromMoveIn, tenancyLeaseIds } from './move-out-copy.ts'

// R-226. A renewal is a new Lease row (D-54) and the move-in report stays on
// the first one, so every deposit-evidence reader has to walk
// `renewedFromLeaseId` back to it. Before this item they all queried the
// current lease's own id, and a tenant who renewed once reached move-out with
// no left-hand side at all.

let entityId: string
let propertyId: string
let unitId: string

beforeAll(async () => {
  const stamp = `baseline-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '12 Renewal Row',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({ data: { propertyId, name: stamp, status: 'OCCUPIED' } })
  unitId = unit.id
})

afterAll(async () => {
  // By ownership. Nothing here is append-only; leases go newest-first
  // because `renewedFromLeaseId` is ON DELETE RESTRICT.
  await prisma.inspectionItem.deleteMany({ where: { inspection: { propertyId } } })
  await prisma.inspection.deleteMany({ where: { propertyId } })
  const leases = await prisma.lease.findMany({ where: { propertyId }, orderBy: { createdAt: 'desc' } })
  for (const lease of leases) await prisma.lease.delete({ where: { id: lease.id } })
  await prisma.unit.deleteMany({ where: { propertyId } })
  await prisma.property.delete({ where: { id: propertyId } })
  await prisma.legalEntity.delete({ where: { id: entityId } })
  await prisma.$disconnect()
})

async function lease(renewedFromLeaseId: string | null) {
  return prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: renewedFromLeaseId ? 'ACTIVE' : 'ENDED',
      origin: renewedFromLeaseId ? 'RENEWAL' : 'APPLICATION',
      renewedFromLeaseId,
      startsOn: new Date('2023-09-01T00:00:00Z'),
      rentCents: 150_000,
    },
  })
}

async function moveIn(leaseId: string, item: string) {
  return prisma.inspection.create({
    data: {
      propertyId,
      unitId,
      leaseId,
      type: 'MOVE_IN',
      performedAt: new Date('2023-09-01T15:00:00Z'),
      items: { create: [{ room: 'Kitchen', item, order: 0 }] },
    },
  })
}

describe('a tenancy that renewed', () => {
  it('reads the move-in report from the first lease, two renewals back', async () => {
    const first = await lease(null)
    const second = await lease(first.id)
    const current = await lease(second.id)
    const report = await moveIn(first.id, 'Countertops')

    expect(await tenancyLeaseIds(prisma, current.id)).toEqual([first.id, second.id, current.id])
    expect(await baselineMoveInFor(prisma, current.id)).toMatchObject({ id: report.id, leaseId: first.id })

    const copy = await itemsFromMoveIn(prisma, current.id)
    expect(copy?.sourceInspectionId).toBe(report.id)
    expect(copy?.items.map((row) => row.item)).toEqual(['Countertops'])
  })

  it('prefers the true start of occupancy over a report opened later on a renewal', async () => {
    const first = await lease(null)
    const renewal = await lease(first.id)
    const original = await moveIn(first.id, 'Original')
    await moveIn(renewal.id, 'Opened by hand on the renewal')

    expect((await baselineMoveInFor(prisma, renewal.id))?.id).toBe(original.id)
  })

  it("falls back to a renewal's own report when the first lease has none", async () => {
    const first = await lease(null)
    const renewal = await lease(first.id)
    const handOpened = await moveIn(renewal.id, 'Only report on record')

    expect((await baselineMoveInFor(prisma, renewal.id))?.id).toBe(handOpened.id)
  })

  it('answers null for a tenancy with no move-in report anywhere', async () => {
    const first = await lease(null)
    const renewal = await lease(first.id)

    expect(await baselineMoveInFor(prisma, renewal.id)).toBeNull()
    expect(await itemsFromMoveIn(prisma, renewal.id)).toBeNull()
  })
})
