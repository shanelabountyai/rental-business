import { type Actor, propertyScope } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { propertyWhere, scopedByProperty } from './scope.ts'

// ROLE-01: "Authorization enforced server-side per role and record scope."
//
// packages/core/rbac proves the DECISIONS in isolation. This proves the
// decisions actually become a where clause that Postgres honours - which is
// the half that leaks data if it is wrong, because a scope that silently
// evaluates to "no filter" looks identical in the UI to a correct one until
// the wrong person opens the rent roll.
//
// Every case below asserts what the actor CAN see and what they CANNOT, from
// a real query against real rows.

let entityOne: string
let entityTwo: string
let propA: string
let propB: string
let propC: string
let ticketA: string
let ticketC: string
const created: { properties: string[]; entities: string[]; tickets: string[] } =
  { properties: [], entities: [], tickets: [] }

beforeAll(async () => {
  const stamp = `rbac-${Date.now()}`

  const e1 = await prisma.legalEntity.create({
    data: { name: `${stamp}-Entity One`, type: 'LLC' },
  })
  const e2 = await prisma.legalEntity.create({
    data: { name: `${stamp}-Entity Two`, type: 'LLC' },
  })
  entityOne = e1.id
  entityTwo = e2.id
  created.entities.push(e1.id, e2.id)

  const makeProperty = async (legalEntityId: string, name: string) =>
    prisma.property.create({
      data: {
        legalEntityId,
        name: `${stamp}-${name}`,
        addressLine1: '1 Test St',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })

  // A and B belong to entity one; C belongs to entity two.
  const a = await makeProperty(entityOne, 'A')
  const b = await makeProperty(entityOne, 'B')
  const c = await makeProperty(entityTwo, 'C')
  propA = a.id
  propB = b.id
  propC = c.id
  created.properties.push(a.id, b.id, c.id)

  const makeTicket = async (propertyId: string) => {
    const unit = await prisma.unit.create({
      data: { propertyId, name: 'Main house' },
    })
    return prisma.ticket.create({
      data: {
        propertyId,
        unitId: unit.id,
        source: 'PORTAL',
        category: 'plumbing',
        description: 'Leak under the sink',
      },
    })
  }
  ticketA = (await makeTicket(propA)).id
  ticketC = (await makeTicket(propC)).id
  created.tickets.push(ticketA, ticketC)
})

afterAll(async () => {
  await prisma.ticket.deleteMany({ where: { id: { in: created.tickets } } })
  await prisma.unit.deleteMany({
    where: { propertyId: { in: created.properties } },
  })
  await prisma.property.deleteMany({
    where: { id: { in: created.properties } },
  })
  await prisma.legalEntity.deleteMany({
    where: { id: { in: created.entities } },
  })
  await prisma.$disconnect()
})

/** Builds an actor holding `property.read` and `ticket.read` over a scope. */
function readerOf(scope: { propertyId?: string; legalEntityId?: string } | 'all') {
  const actor: Actor = {
    id: 'staff_test',
    kind: 'staff',
    active: true,
    mfaVerified: true,
    assignments: [
      {
        roleKey: 'read_only',
        permissions: ['property.read', 'ticket.read'],
        propertyId: scope === 'all' ? null : (scope.propertyId ?? null),
        legalEntityId: scope === 'all' ? null : (scope.legalEntityId ?? null),
      },
    ],
    leaseIds: [],
    ceilings: { approveWorkOrderCents: 0, waiveFeeCents: 0 },
  }
  return actor
}

async function visibleProperties(actor: Actor) {
  const where = propertyWhere(propertyScope(actor, 'property.read'))
  if (where === null) return []
  const rows = await prisma.property.findMany({
    where: { AND: [where, { id: { in: created.properties } }] },
    select: { id: true },
  })
  return rows.map((row) => row.id).sort()
}

async function visibleTickets(actor: Actor) {
  const where = scopedByProperty(propertyScope(actor, 'ticket.read'))
  if (where === null) return []
  const rows = await prisma.ticket.findMany({
    where: { AND: [where, { id: { in: created.tickets } }] },
    select: { id: true },
  })
  return rows.map((row) => row.id).sort()
}

describe('property scoping in the query', () => {
  it('shows a portfolio-wide actor everything', async () => {
    expect(await visibleProperties(readerOf('all'))).toEqual(
      [propA, propB, propC].sort(),
    )
  })

  it('shows a property-scoped actor exactly one property', async () => {
    expect(await visibleProperties(readerOf({ propertyId: propB }))).toEqual([
      propB,
    ])
  })

  it('shows an entity-scoped actor that entity only (ROLE-04)', async () => {
    // The partner who "sees only her 6 units".
    expect(
      await visibleProperties(readerOf({ legalEntityId: entityOne })),
    ).toEqual([propA, propB].sort())
  })

  it('shows nothing to an actor without the permission', async () => {
    const stranger = readerOf('all')
    const noPermissions: Actor = {
      ...stranger,
      assignments: [
        { ...stranger.assignments[0]!, permissions: ['ticket.read'] },
      ],
    }
    expect(await visibleProperties(noPermissions)).toEqual([])
  })

  // The failure this whole file exists to catch: an empty scope must mean "no
  // rows", never "no filter". If propertyWhere returned {} here, a
  // deactivated user would see the entire portfolio.
  it('shows nothing to a deactivated actor', async () => {
    const gone: Actor = { ...readerOf('all'), active: false }
    expect(propertyWhere(propertyScope(gone, 'property.read'))).toBeNull()
    expect(await visibleProperties(gone)).toEqual([])
  })
})

describe('scoping rows that carry propertyId', () => {
  it('shows a portfolio-wide actor every ticket', async () => {
    expect(await visibleTickets(readerOf('all'))).toEqual(
      [ticketA, ticketC].sort(),
    )
  })

  it('confines a property-scoped actor to their property', async () => {
    expect(await visibleTickets(readerOf({ propertyId: propA }))).toEqual([
      ticketA,
    ])
  })

  // Ticket has no legalEntityId - R-002 denormalized propertyId, not entity -
  // so an entity grant has to reach through the property relation.
  it('resolves an entity grant through the property relation', async () => {
    expect(
      await visibleTickets(readerOf({ legalEntityId: entityTwo })),
    ).toEqual([ticketC])
  })

  it('shows nothing when the scope is empty', async () => {
    const gone: Actor = { ...readerOf('all'), active: false }
    expect(scopedByProperty(propertyScope(gone, 'ticket.read'))).toBeNull()
    expect(await visibleTickets(gone)).toEqual([])
  })

  it('unions a property grant and an entity grant', async () => {
    const mixed = readerOf('all')
    const both: Actor = {
      ...mixed,
      assignments: [
        {
          roleKey: 'read_only',
          permissions: ['ticket.read'],
          propertyId: propA,
          legalEntityId: null,
        },
        {
          roleKey: 'read_only',
          permissions: ['ticket.read'],
          propertyId: null,
          legalEntityId: entityTwo,
        },
      ],
    }
    expect(await visibleTickets(both)).toEqual([ticketA, ticketC].sort())
  })
})

describe('seeded roles', () => {
  it('has all six roles as rows, not as constants', async () => {
    const roles = await prisma.role.findMany({ select: { key: true } })
    expect(roles.map((r) => r.key).sort()).toEqual([
      'guarantor',
      'maintenance_tech',
      'manager',
      'owner',
      'read_only',
      'tenant',
    ])
  })

  it('gives the owner role a full permission list rather than a wildcard', async () => {
    const owner = await prisma.role.findUnique({ where: { key: 'owner' } })
    expect(owner!.permissions).toContain('ledger.adjust')
    expect(owner!.permissions).toContain('staff.manage')
    expect(owner!.permissions).not.toContain('*')
  })
})

describe('assignment integrity', () => {
  it('refuses an assignment scoped to a property AND an entity at once', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
    const staff = await prisma.staffUser.create({
      data: { email: `scope-${Date.now()}@example.test`, name: 'Scope Test' },
    })

    // An ambiguous scope means one reader sees a narrow grant and another sees
    // a wide one. The check constraint rejects the row instead.
    await expect(
      prisma.staffAssignment.create({
        data: {
          staffUserId: staff.id,
          roleId: role.id,
          propertyId: propA,
          legalEntityId: entityOne,
        },
      }),
    ).rejects.toThrow(/scope_is_unambiguous|constraint/i)

    await prisma.staffUser.delete({ where: { id: staff.id } })
  })

  it('refuses a duplicate live grant of the same role and scope', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
    const staff = await prisma.staffUser.create({
      data: { email: `dupe-${Date.now()}@example.test`, name: 'Dupe Test' },
    })

    // Portfolio-wide grants have two NULL scope columns, and NULL never equals
    // NULL - so without the COALESCE in the index, the MOST privileged
    // assignment would be the one duplicate-protection missed.
    await prisma.staffAssignment.create({
      data: { staffUserId: staff.id, roleId: role.id },
    })
    await expect(
      prisma.staffAssignment.create({
        data: { staffUserId: staff.id, roleId: role.id },
      }),
    ).rejects.toThrow(/one_live_grant|[Uu]nique/)

    // Revoking frees the slot, and the revoked row stays for history (ROLE-06).
    await prisma.staffAssignment.updateMany({
      where: { staffUserId: staff.id },
      data: { revokedAt: new Date() },
    })
    const regranted = await prisma.staffAssignment.create({
      data: { staffUserId: staff.id, roleId: role.id },
    })
    expect(regranted.id).toBeTruthy()
    expect(
      await prisma.staffAssignment.count({ where: { staffUserId: staff.id } }),
    ).toBe(2)

    await prisma.staffAssignment.deleteMany({ where: { staffUserId: staff.id } })
    await prisma.staffUser.delete({ where: { id: staff.id } })
  })
})
