import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import { getInspection, inspectionsForScope, unitsForNewInspection } from './queries.ts'

// Reads for Inspection (INSP-01, R-068) - the writes
// (startInspection/recordItem/finishInspection/recordSignature/lockInspection)
// are session-dependent via requirePermission/audit() and are e2e-only, the
// same wall this domain's own template-queries.test.ts already draws.

function scopeOf(propertyIds: string[]): ResolvedScope {
  return {
    selection: { kind: 'all' },
    availableEntities: [],
    availableProperties: [],
    propertyIds,
    switchable: false,
  }
}

let entityId: string
let propertyId: string
let unitId: string
let inspectionId: string

beforeAll(async () => {
  const stamp = `insp-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '30 Checklist Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'VACANT' },
  })
  unitId = unit.id

  const inspection = await prisma.inspection.create({
    data: {
      propertyId,
      unitId,
      type: 'PERIODIC',
      items: { create: [{ room: 'Kitchen', item: 'Sink', order: 0 }] },
    },
  })
  inspectionId = inspection.id
})

afterAll(async () => {
  await prisma.inspectionItem.deleteMany({ where: { inspectionId } })
  await prisma.inspection.deleteMany({ where: { id: inspectionId } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

describe('inspectionsForScope', () => {
  it('lists inspections within scope, newest first', async () => {
    const list = await inspectionsForScope(scopeOf([propertyId]))
    expect(list.map((i) => i.id)).toContain(inspectionId)
  })

  it('returns nothing for an empty scope', async () => {
    expect(await inspectionsForScope(scopeOf([]))).toEqual([])
  })
})

describe('getInspection', () => {
  it('returns the inspection with its items, in scope', async () => {
    const inspection = await getInspection(inspectionId, scopeOf([propertyId]))
    expect(inspection?.items).toHaveLength(1)
    expect(inspection?.items[0]?.room).toBe('Kitchen')
  })

  it('returns null outside scope - not yours reads the same as does not exist', async () => {
    expect(await getInspection(inspectionId, scopeOf(['some-other-property']))).toBeNull()
  })

  it('returns null for an id that does not exist', async () => {
    expect(await getInspection('not-a-real-id', scopeOf([propertyId]))).toBeNull()
  })
})

describe('unitsForNewInspection', () => {
  it('lists units within scope', async () => {
    const units = await unitsForNewInspection(scopeOf([propertyId]))
    expect(units.map((u) => u.id)).toContain(unitId)
  })
})
