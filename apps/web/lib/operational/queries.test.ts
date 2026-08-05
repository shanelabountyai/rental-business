import { sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getAccessCode, getAccessCodeHistory, getOperationalData } from './queries.ts'

let propA: string
let propB: string
let unitA: string
let entityId: string
const accessCodeIds: string[] = []
const applianceIds: string[] = []
const utilityIds: string[] = []
const shutoffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []

function scopeOf(propertyIds: string[]) {
  return {
    selection: { kind: 'all' as const },
    availableEntities: [],
    availableProperties: [],
    propertyIds,
    switchable: propertyIds.length > 1,
  }
}

beforeAll(async () => {
  const stamp = `opq-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id

  const makeProperty = async (name: string) => {
    const property = await prisma.property.create({
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
    propertyIds.push(property.id)
    return property
  }
  const a = await makeProperty('A')
  const b = await makeProperty('B')
  propA = a.id
  propB = b.id

  const unit = await prisma.unit.create({
    data: { propertyId: propA, name: 'Main house', status: 'OCCUPIED' },
  })
  unitA = unit.id
  unitIds.push(unit.id)

  const v1 = await prisma.accessCode.create({
    data: {
      unitId: unitA,
      type: 'LOCKBOX',
      sealedCode: sealSecret('1111', 'access-code'),
      version: 1,
      effectiveTo: new Date('2020-01-01'),
    },
  })
  const v2 = await prisma.accessCode.create({
    data: {
      unitId: unitA,
      type: 'LOCKBOX',
      sealedCode: sealSecret('2222', 'access-code'),
      version: 2,
    },
  })
  accessCodeIds.push(v1.id, v2.id)

  const appliance = await prisma.appliance.create({
    data: { unitId: unitA, category: 'HVAC', filterSize: '16x25x1' },
  })
  applianceIds.push(appliance.id)

  const utility = await prisma.utilityAccount.create({
    data: { unitId: unitA, type: 'ELECTRIC', provider: 'Austin Energy' },
  })
  utilityIds.push(utility.id)

  const shutoff = await prisma.shutoffLocation.create({
    data: { unitId: unitA, type: 'WATER_MAIN', description: 'Left side, under the hose bib.' },
  })
  shutoffIds.push(shutoff.id)
})

afterAll(async () => {
  await prisma.accessCode.deleteMany({ where: { id: { in: accessCodeIds } } })
  await prisma.appliance.deleteMany({ where: { id: { in: applianceIds } } })
  await prisma.utilityAccount.deleteMany({ where: { id: { in: utilityIds } } })
  await prisma.shutoffLocation.deleteMany({ where: { id: { in: shutoffIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } })
  await prisma.legalEntity.delete({ where: { id: entityId } })
  await prisma.$disconnect()
})

describe('getOperationalData', () => {
  it('returns only the current access-code version, plus every appliance/utility/shutoff', async () => {
    const data = await getOperationalData(propA, unitA, scopeOf([propA, propB]))
    expect(data?.accessCodes).toHaveLength(1)
    expect(data?.accessCodes[0]?.version).toBe(2)
    expect(data?.appliances).toHaveLength(1)
    expect(data?.utilityAccounts).toHaveLength(1)
    expect(data?.shutoffs).toHaveLength(1)
  })

  it('returns null when the property is outside scope', async () => {
    expect(await getOperationalData(propA, unitA, scopeOf([propB]))).toBeNull()
  })
})

describe('getAccessCodeHistory', () => {
  it('returns every version, newest first', async () => {
    const history = await getAccessCodeHistory(propA, unitA, 'LOCKBOX', scopeOf([propA]))
    expect(history.map((c) => c.version)).toEqual([2, 1])
  })

  it('returns nothing outside scope', async () => {
    expect(await getAccessCodeHistory(propA, unitA, 'LOCKBOX', scopeOf([propB]))).toEqual([])
  })
})

describe('getAccessCode', () => {
  it('returns a code belonging to the named unit', async () => {
    const code = await getAccessCode(propA, unitA, accessCodeIds[1]!, scopeOf([propA]))
    expect(code?.version).toBe(2)
  })

  it('returns null outside scope', async () => {
    expect(await getAccessCode(propA, unitA, accessCodeIds[1]!, scopeOf([propB]))).toBeNull()
  })
})
