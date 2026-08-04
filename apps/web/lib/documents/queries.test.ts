import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  documentsPastRetention,
  getDocument,
  listDeletedDocuments,
  listDocuments,
} from './queries.ts'

let entityId: string
let propA: string
let propB: string
let unitA1: string
const documentIds: string[] = []
const unitIds: string[] = []
const propertyIds: string[] = []

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
  const stamp = `docq-${Date.now()}`
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
  unitA1 = unit.id
  unitIds.push(unit.id)

  const makeDocument = async (data: {
    propertyId: string
    unitId?: string | null
    type?: string
    deletedAt?: Date | null
    createdAt?: Date
  }) => {
    const document = await prisma.document.create({
      data: {
        propertyId: data.propertyId,
        unitId: data.unitId,
        type: data.type ?? 'PROPERTY_PHOTO',
        fileName: 'test.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        storageKey: `test/${randomUUID()}.jpg`,
        deletedAt: data.deletedAt,
        ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      },
    })
    documentIds.push(document.id)
    return document
  }

  await makeDocument({ propertyId: propA, type: 'PROPERTY_PHOTO' })
  await makeDocument({ propertyId: propA, unitId: unitA1, type: 'UNIT_PHOTO' })
  await makeDocument({ propertyId: propA, deletedAt: new Date() })
  await makeDocument({ propertyId: propB, type: 'PROPERTY_PHOTO' })
  // A lease document old enough to be past its 7-year retention window.
  await makeDocument({
    propertyId: propA,
    type: 'LEASE',
    createdAt: new Date('2010-01-01T00:00:00.000Z'),
  })
})

afterAll(async () => {
  await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } })
  await prisma.legalEntity.delete({ where: { id: entityId } })
  await prisma.$disconnect()
})

describe('listDocuments', () => {
  it('lists active property-level documents, excluding unit-attached and deleted ones', async () => {
    const docs = await listDocuments(propA, scopeOf([propA, propB]))
    const types = docs.map((d) => d.type)
    expect(types).toContain('PROPERTY_PHOTO')
    expect(types).toContain('LEASE')
    expect(docs.every((d) => d.unitId === null)).toBe(true)
    expect(docs.every((d) => d.deletedAt === null)).toBe(true)
  })

  it('lists documents attached to a specific unit', async () => {
    const docs = await listDocuments(propA, scopeOf([propA]), unitA1)
    expect(docs).toHaveLength(1)
    expect(docs[0]!.type).toBe('UNIT_PHOTO')
  })

  it('returns nothing when the property is outside scope', async () => {
    expect(await listDocuments(propA, scopeOf([propB]))).toEqual([])
  })
})

describe('listDeletedDocuments', () => {
  it('lists only soft-deleted documents', async () => {
    const deleted = await listDeletedDocuments(propA, scopeOf([propA]))
    expect(deleted).toHaveLength(1)
    expect(deleted[0]!.deletedAt).not.toBeNull()
  })
})

describe('getDocument', () => {
  it('returns a document whose property is in scope', async () => {
    const docs = await listDocuments(propA, scopeOf([propA]))
    const doc = await getDocument(docs[0]!.id, scopeOf([propA]))
    expect(doc?.id).toBe(docs[0]!.id)
    expect(doc?.property.id).toBe(propA)
  })

  it('returns null when the property is outside scope', async () => {
    const docs = await listDocuments(propA, scopeOf([propA]))
    expect(await getDocument(docs[0]!.id, scopeOf([propB]))).toBeNull()
  })
})

describe('documentsPastRetention', () => {
  it('flags a LEASE document created well over 7 years ago', async () => {
    const due = await documentsPastRetention(scopeOf([propA, propB]), new Date())
    expect(due.some((d) => d.document.type === 'LEASE')).toBe(true)
  })

  it('does not flag a document type with no automatic window', async () => {
    const due = await documentsPastRetention(scopeOf([propA, propB]), new Date())
    expect(due.some((d) => d.document.type === 'PROPERTY_PHOTO')).toBe(false)
  })
})
