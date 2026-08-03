import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getUnitDetail, listUnits } from './queries.ts'

// Scoped reads for Unit, against a real database. A Unit has no
// legalEntityId of its own, only propertyId - the SAME scoping bug class
// R-008 found and fixed for property.write (see propertyResource in
// guard.ts) would be trivial to reintroduce here by scoping through
// propertyId alone, so this asserts the query actually respects a resolved
// scope end to end, not just that the code compiles.

let entityId: string
let propA: string
let propB: string
let unitA1: string
let unitA2: string
let unitB1: string

const created = { units: [] as string[], properties: [] as string[] }

beforeAll(async () => {
  const stamp = `unitq-${Date.now()}`
  const entity = await prisma.legalEntity.create({
    data: { name: stamp, type: 'LLC' },
  })
  entityId = entity.id

  const makeProperty = async (name: string) =>
    prisma.property.create({
      data: {
        legalEntityId: entityId,
        name: `${stamp}-${name}`,
        addressLine1: '1 Test St',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
  const a = await makeProperty('A')
  const b = await makeProperty('B')
  propA = a.id
  propB = b.id
  created.properties.push(a.id, b.id)

  const a1 = await prisma.unit.create({
    data: { propertyId: propA, name: 'Main house', status: 'OCCUPIED' },
  })
  const a2 = await prisma.unit.create({
    data: { propertyId: propA, name: 'ADU', status: 'VACANT' },
  })
  const b1 = await prisma.unit.create({
    data: { propertyId: propB, name: 'Main house', status: 'OCCUPIED' },
  })
  unitA1 = a1.id
  unitA2 = a2.id
  unitB1 = b1.id
  created.units.push(a1.id, a2.id, b1.id)
})

afterAll(async () => {
  await prisma.unit.deleteMany({ where: { id: { in: created.units } } })
  await prisma.property.deleteMany({ where: { id: { in: created.properties } } })
  await prisma.legalEntity.delete({ where: { id: entityId } })
  await prisma.$disconnect()
})

function scopeOf(propertyIds: string[]) {
  return {
    selection: { kind: 'all' as const },
    availableEntities: [],
    availableProperties: [],
    propertyIds,
    switchable: propertyIds.length > 1,
  }
}

describe('listUnits', () => {
  it('lists every unit at an in-scope property', async () => {
    const units = await listUnits(propA, scopeOf([propA, propB]))
    expect(units.map((u) => u.id).sort()).toEqual([unitA1, unitA2].sort())
  })

  it('lists nothing when the property itself is outside scope', async () => {
    // The realistic case: a manager scoped to property B tries to list
    // property A's units by URL. Not "empty because no units" - refused
    // because the property is not theirs.
    expect(await listUnits(propA, scopeOf([propB]))).toEqual([])
  })
})

describe('getUnitDetail', () => {
  it('returns a unit whose property is in scope', async () => {
    const unit = await getUnitDetail(propA, unitA1, scopeOf([propA]))
    expect(unit?.id).toBe(unitA1)
    expect(unit?.property.id).toBe(propA)
  })

  it('returns null when the property is outside scope', async () => {
    expect(await getUnitDetail(propA, unitA1, scopeOf([propB]))).toBeNull()
  })

  // The check this test exists for: a unit id from property B requested
  // under property A's URL must not render, even though B is genuinely in
  // scope - the unit simply does not belong to the property named in the
  // route.
  it('returns null when the unit belongs to a different property than the one named', async () => {
    expect(
      await getUnitDetail(propA, unitB1, scopeOf([propA, propB])),
    ).toBeNull()
  })
})
