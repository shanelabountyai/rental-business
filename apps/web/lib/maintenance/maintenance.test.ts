import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTenantCurrentHome, getTenantTicket, listTenantTickets } from './queries.ts'

// Reads for the tenant maintenance flow, against a real database (R-019).
// Scoping is exercised directly here (manually-built TenantScope objects,
// bypassing auth()) - the same split R-018's portal.test.ts uses, since
// requireTenantWithScope() depends on a real Auth.js session and is covered
// by e2e/portal-maintenance.spec.ts instead.

let entityId: string
let propertyId: string
let unitId: string
let myLeaseId: string
let meId: string
let themId: string

const ticketIds: string[] = []
const tenantIds: string[] = []

beforeAll(async () => {
  const stamp = `maint-${Date.now()}`
  const entity = await prisma.legalEntity.create({
    data: { name: stamp, type: 'LLC' },
  })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'DUPLEX',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  unitId = unit.id

  const makeTenantWithLease = async (label: string, startsOn: Date) => {
    const tenant = await prisma.tenant.create({
      data: { firstName: label, lastName: `T-${randomUUID().slice(0, 6)}` },
    })
    tenantIds.push(tenant.id)
    const lease = await prisma.lease.create({
      data: { propertyId, unitId, status: 'ACTIVE', startsOn, rentCents: 150_000 },
    })
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId: tenant.id },
    })
    return { tenantId: tenant.id, leaseId: lease.id }
  }

  const mine = await makeTenantWithLease('Me', new Date('2026-01-01'))
  meId = mine.tenantId
  myLeaseId = mine.leaseId
  themId = (await makeTenantWithLease('Them', new Date('2026-01-01'))).tenantId
})

afterAll(async () => {
  await prisma.document.deleteMany({
    where: { ticketId: { in: ticketIds } },
  })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.property.updateMany({
    where: { id: propertyId },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

function myScope() {
  return { tenantId: meId, leaseIds: [myLeaseId] }
}

async function makeTicket(tenantId: string, overrides: Partial<{ category: string }> = {}) {
  const ticket = await prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      tenantId,
      source: 'PORTAL',
      category: overrides.category ?? 'PLUMBING',
      description: 'Test ticket',
    },
  })
  ticketIds.push(ticket.id)
  return ticket
}

describe('getTenantCurrentHome', () => {
  it('returns the property and unit from the most recent lease', async () => {
    const home = await getTenantCurrentHome(myScope())
    expect(home?.propertyId).toBe(propertyId)
    expect(home?.unitId).toBe(unitId)
    expect(home?.id).toBe(myLeaseId)
  })

  it('returns null for a tenant with no lease', async () => {
    expect(await getTenantCurrentHome({ tenantId: meId, leaseIds: [] })).toBeNull()
  })
})

describe('a tenant sees only their own maintenance requests', () => {
  it('lists their own tickets', async () => {
    const ticket = await makeTicket(meId, { category: 'ELECTRICAL' })
    const list = await listTenantTickets(myScope())
    expect(list.map((t) => t.id)).toContain(ticket.id)
  })

  it('never lists another tenant’s ticket', async () => {
    const theirTicket = await makeTicket(themId)
    const list = await listTenantTickets(myScope())
    expect(list.map((t) => t.id)).not.toContain(theirTicket.id)
  })

  it('refuses a direct fetch of another tenant’s ticket by id', async () => {
    // The list being right is not enough - the id is guessable. Null, not an
    // error: "not yours" and "does not exist" must be indistinguishable.
    const theirTicket = await makeTicket(themId)
    expect(await getTenantTicket(theirTicket.id, myScope())).toBeNull()
  })

  it('returns their own ticket with its attached photos', async () => {
    const ticket = await makeTicket(meId)
    const document = await prisma.document.create({
      data: {
        propertyId,
        unitId,
        tenantId: meId,
        ticketId: ticket.id,
        type: 'MAINTENANCE_PHOTO',
        fileName: 'leak.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        storageKey: `test/${randomUUID()}`,
      },
    })

    const found = await getTenantTicket(ticket.id, myScope())
    expect(found?.id).toBe(ticket.id)
    expect(found?.documents.map((d) => d.id)).toContain(document.id)
  })

  it('does not show a soft-deleted photo on the ticket', async () => {
    const ticket = await makeTicket(meId)
    await prisma.document.create({
      data: {
        propertyId,
        unitId,
        tenantId: meId,
        ticketId: ticket.id,
        type: 'MAINTENANCE_PHOTO',
        fileName: 'deleted.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        storageKey: `test/${randomUUID()}`,
        deletedAt: new Date(),
      },
    })
    const found = await getTenantTicket(ticket.id, myScope())
    expect(found?.documents.map((d) => d.fileName)).not.toContain('deleted.jpg')
  })
})
