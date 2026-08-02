import type { Actor } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  candidateDuplicateProperties,
  getPropertyDetail,
  listProperties,
  listWritableLegalEntities,
} from './queries.ts'

// Scoped reads for Properties, against a real database. What matters here is
// exactly what R-004's own tests care about: a scope that resolves to "see
// nothing" must return nothing, never accidentally fall through to "see
// everything" - and a duplicate-address check must never surface a property
// the actor could not otherwise see.

let entityOne: string
let entityTwo: string
let propA: string
let propB: string
let propC: string

const created = { properties: [] as string[], entities: [] as string[] }

beforeAll(async () => {
  const stamp = `propq-${Date.now()}`

  const e1 = await prisma.legalEntity.create({
    data: { name: `${stamp}-One`, type: 'LLC' },
  })
  const e2 = await prisma.legalEntity.create({
    data: { name: `${stamp}-Two`, type: 'LLC' },
  })
  entityOne = e1.id
  entityTwo = e2.id
  created.entities.push(e1.id, e2.id)

  const makeProperty = async (
    legalEntityId: string,
    name: string,
    addressLine1: string,
  ) =>
    prisma.property.create({
      data: {
        legalEntityId,
        name,
        addressLine1,
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })

  const a = await makeProperty(entityOne, `${stamp}-A`, '100 Elm St')
  const b = await makeProperty(entityOne, `${stamp}-B`, '200 Oak St')
  const c = await makeProperty(entityTwo, `${stamp}-C`, '300 Pine St')
  propA = a.id
  propB = b.id
  propC = c.id
  created.properties.push(a.id, b.id, c.id)
})

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: created.properties } } })
  await prisma.legalEntity.deleteMany({ where: { id: { in: created.entities } } })
  await prisma.$disconnect()
})

function actorWith(assignments: Actor['assignments']): Actor {
  return {
    id: 'staff_test',
    kind: 'staff',
    active: true,
    mfaVerified: true,
    assignments,
    leaseIds: [],
    ceilings: { approveWorkOrderCents: 0, waiveFeeCents: 0 },
  }
}

const portfolioWide = actorWith([
  {
    roleKey: 'owner',
    permissions: ['property.read', 'property.write'],
    propertyId: null,
    legalEntityId: null,
  },
])

describe('listProperties', () => {
  it('lists nothing for an empty resolved scope', async () => {
    const properties = await listProperties({
      selection: { kind: 'all' },
      availableEntities: [],
      availableProperties: [],
      propertyIds: [],
      switchable: false,
    })
    expect(properties).toEqual([])
  })

  it('lists exactly the ids the resolved scope names', async () => {
    const properties = await listProperties({
      selection: { kind: 'property', propertyId: propA },
      availableEntities: [],
      availableProperties: [],
      propertyIds: [propA],
      switchable: false,
    })
    expect(properties.map((p) => p.id)).toEqual([propA])
    expect(properties[0]!.legalEntity.id).toBe(entityOne)
  })
})

describe('getPropertyDetail', () => {
  it('returns a property inside the resolved scope', async () => {
    const scope = {
      selection: { kind: 'all' as const },
      availableEntities: [],
      availableProperties: [],
      propertyIds: [propA, propB],
      switchable: true,
    }
    const property = await getPropertyDetail(propA, scope)
    expect(property?.id).toBe(propA)
  })

  // The check that matters: a property just outside the resolved scope must
  // come back null, not the row. This is what stops a scoped manager from
  // reading a property by guessing its id in the URL.
  it('returns null for a property outside the resolved scope', async () => {
    const scope = {
      selection: { kind: 'all' as const },
      availableEntities: [],
      availableProperties: [],
      propertyIds: [propA],
      switchable: false,
    }
    expect(await getPropertyDetail(propC, scope)).toBeNull()
  })
})

describe('listWritableLegalEntities', () => {
  it('lists every active entity for a portfolio-wide grant', async () => {
    const entities = await listWritableLegalEntities(portfolioWide)
    const ids = entities.map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining([entityOne, entityTwo]))
  })

  it('lists only the entity an entity-scoped manager may write to', async () => {
    const scoped = actorWith([
      {
        roleKey: 'manager',
        permissions: ['property.read', 'property.write'],
        propertyId: null,
        legalEntityId: entityOne,
      },
    ])
    const entities = await listWritableLegalEntities(scoped)
    expect(entities.map((e) => e.id)).toEqual([entityOne])
  })

  // The rule from packages/core/rbac's assignmentCovers: a property-scoped
  // grant matches only that exact propertyId, and creating a NEW property has
  // no propertyId yet - so a property-scoped manager can edit their property
  // but cannot create another, anywhere. Confirmed here against the database
  // query, not just the in-memory decision.
  it('lists nothing for a property-scoped manager, who cannot create new properties at all', async () => {
    const scoped = actorWith([
      {
        roleKey: 'manager',
        permissions: ['property.read', 'property.write'],
        propertyId: propA,
        legalEntityId: null,
      },
    ])
    expect(await listWritableLegalEntities(scoped)).toEqual([])
  })
})

describe('candidateDuplicateProperties', () => {
  it('only returns properties the actor can already read', async () => {
    const scoped = actorWith([
      {
        roleKey: 'manager',
        permissions: ['property.read'],
        propertyId: propA,
        legalEntityId: null,
      },
    ])
    const candidates = await candidateDuplicateProperties(scoped)
    // Sees its own property, and specifically NOT propB or propC - a wider
    // check here would leak the existence of properties outside this actor's
    // scope through the duplicate-warning message.
    expect(candidates.map((c) => c.id)).toEqual([propA])
  })

  it('sees the whole portfolio for a portfolio-wide reader', async () => {
    const candidates = await candidateDuplicateProperties(portfolioWide)
    const ids = candidates.map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining([propA, propB, propC]))
  })

  it('returns nothing for an actor with no read access at all', async () => {
    const blind = actorWith([])
    expect(await candidateDuplicateProperties(blind)).toEqual([])
  })
})
