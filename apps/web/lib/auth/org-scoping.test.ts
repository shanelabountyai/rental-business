import { type Actor, propertyScope } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { propertyWhere, scopedByProperty, tenantWhere } from './scope.ts'

// ORG-07 (R-285b, PRD 10 §1.3): a null/null owner grant is portfolio-wide
// WITHIN ITS ORGANISATION and nothing more. Before R-285b `propertyWhere`
// returned `{}` for `everything`, so the owner of org #0 listed every
// organisation's properties, tenants and tickets. This proves the bound
// against real rows in a second org, through every scope reader and the
// property switcher - the four places a list query gets its where clause.

// The switcher reads its selection from a cookie. One test names org B's
// property in it, the way a hand-edited cookie would.
const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (cookie.value ? { value: cookie.value } : undefined) }),
}))
const { currentScope } = await import('../scope/current-scope.ts')

const ORG_0 = 'org_0'
let orgB = ''
let entityA = ''
let propA = ''
let propB = ''
let tenantA = ''
let tenantB = ''
let ticketA = ''
let ticketB = ''

beforeAll(async () => {
  const stamp = `org07-${Date.now()}`
  orgB = (await prisma.organization.create({ data: { slug: stamp, name: `${stamp} Org B` } })).id

  // Same shape in both orgs: entity, property, unit, a lease with a tenant on
  // it, and a ticket.
  const seed = async (orgId: string, name: string) => {
    const entity = await prisma.legalEntity.create({ data: { orgId, name: `${stamp}-${name}`, type: 'LLC' } })
    const property = await prisma.property.create({
      data: {
        legalEntityId: entity.id,
        name: `${stamp}-${name}`,
        addressLine1: '1 Test St',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
    const unit = await prisma.unit.create({ data: { propertyId: property.id, name: 'Main house' } })
    const lease = await prisma.lease.create({
      data: { propertyId: property.id, unitId: unit.id, startsOn: new Date('2026-01-01'), rentCents: 150000 },
    })
    const tenant = await prisma.tenant.create({
      data: { orgId, firstName: 'Org', lastName: stamp, leaseTenants: { create: { leaseId: lease.id } } },
    })
    const ticket = await prisma.ticket.create({
      data: { propertyId: property.id, unitId: unit.id, source: 'PORTAL', category: 'plumbing', description: 'Leak' },
    })
    return { entity: entity.id, property: property.id, tenant: tenant.id, ticket: ticket.id }
  }
  const a = await seed(ORG_0, 'A')
  const b = await seed(orgB, 'B')
  entityA = a.entity
  propA = a.property
  propB = b.property
  tenantA = a.tenant
  tenantB = b.tenant
  ticketA = a.ticket
  ticketB = b.ticket
})

// By ownership: everything under entity A, everything in org B.
afterAll(async () => {
  const mine = { OR: [{ property: { legalEntityId: entityA } }, { orgId: orgB }] }
  await prisma.leaseTenant.deleteMany({ where: { OR: [{ lease: { property: { legalEntityId: entityA } } }, { orgId: orgB }] } })
  await prisma.ticket.deleteMany({ where: mine })
  await prisma.lease.deleteMany({ where: mine })
  await prisma.unit.deleteMany({ where: mine })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
  await prisma.property.deleteMany({ where: { OR: [{ legalEntityId: entityA }, { orgId: orgB }] } })
  await prisma.legalEntity.deleteMany({ where: { OR: [{ id: entityA }, { orgId: orgB }] } })
  await prisma.organization.deleteMany({ where: { id: orgB } })
  await prisma.$disconnect()
})

/** An owner-shaped null/null grant in `orgId`. */
function ownerOf(orgId: string): Actor {
  return {
    id: 'staff_org07',
    orgId,
    kind: 'staff',
    active: true,
    mfaVerified: true,
    assignments: [
      {
        orgId,
        roleKey: 'owner',
        permissions: ['property.read', 'ticket.read', 'tenant.read'],
        propertyId: null,
        legalEntityId: null,
      },
    ],
    leaseIds: [],
    ceilings: { approveWorkOrderCents: 0, waiveFeeCents: 0 },
  }
}

async function seen(actor: Actor) {
  const scope = propertyScope(actor, 'property.read')
  const property = propertyWhere(scope)
  const tenant = tenantWhere(scope)
  const ticket = scopedByProperty(propertyScope(actor, 'ticket.read'))
  // Not null: `everything` is a bounded scope, not an empty one.
  expect(property).not.toBeNull()
  expect(tenant).not.toBeNull()
  expect(ticket).not.toBeNull()
  const [properties, tenants, tickets] = await Promise.all([
    prisma.property.findMany({ where: { AND: [property!, { id: { in: [propA, propB] } }] }, select: { id: true } }),
    prisma.tenant.findMany({ where: { AND: [tenant!, { id: { in: [tenantA, tenantB] } }] }, select: { id: true } }),
    prisma.ticket.findMany({ where: { AND: [ticket!, { id: { in: [ticketA, ticketB] } }] }, select: { id: true } }),
  ])
  return {
    properties: properties.map((r) => r.id),
    tenants: tenants.map((r) => r.id),
    tickets: tickets.map((r) => r.id),
  }
}

describe('ORG-07: a portfolio-wide grant stops at its organisation', () => {
  it("org #0's owner sees org #0 and nothing of org B", async () => {
    expect(await seen(ownerOf(ORG_0))).toEqual({ properties: [propA], tenants: [tenantA], tickets: [ticketA] })
  })

  it("org B's owner sees org B and nothing of org #0", async () => {
    expect(await seen(ownerOf(orgB))).toEqual({ properties: [propB], tenants: [tenantB], tickets: [ticketB] })
  })

  it('an owner grant from org B held by an actor acting in org #0 grants nothing', () => {
    const actor: Actor = { ...ownerOf(ORG_0), assignments: ownerOf(orgB).assignments }
    expect(propertyWhere(propertyScope(actor, 'property.read'))).toBeNull()
    expect(tenantWhere(propertyScope(actor, 'property.read'))).toBeNull()
    expect(scopedByProperty(propertyScope(actor, 'ticket.read'))).toBeNull()
  })

  it("the property switcher lists only the actor's org, and a cookie naming org B's property falls back", async () => {
    cookie.value = `property:${propB}`
    try {
      const scope = await currentScope(ownerOf(ORG_0), 'property.read')
      const available = scope.availableProperties.map((p) => p.id)
      expect(available).toContain(propA)
      expect(available).not.toContain(propB)
      expect(scope.availableEntities.map((e) => e.id)).toContain(entityA)
      expect(scope.selection).toEqual({ kind: 'all' })
      expect(scope.propertyIds).not.toContain(propB)
    } finally {
      cookie.value = undefined
    }
  })
})
