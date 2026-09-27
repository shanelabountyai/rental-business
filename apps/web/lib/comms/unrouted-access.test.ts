import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadStaffActor } from '@/lib/auth/actor.ts'
import { fileUnroutedMessage } from './actions.ts'
import { listUnroutedMessages, unroutedCount } from './queries.ts'

// SEC-16 / D-266: only portfolio-wide staff see and file the unrouted inbox.
// Session mocked, grants and the RBAC decision real (the seam
// cross-property-ids.test.ts uses). `redirect` throws its URL so a refusal
// (/no-access) and a successful filing (/messages/<thread>) are told apart.

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`)
  },
}))
const session = vi.hoisted(() => ({ staffId: '' }))
vi.mock('@/auth.ts', () => ({
  auth: async () => ({ principal: { kind: 'staff', id: session.staffId, mfaVerified: true } }),
}))

const unique = randomUUID().slice(0, 8)
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const unroutedIds: string[] = []

async function house(label: string) {
  const entity = await prisma.legalEntity.create({ data: { name: `unrouted-${label}-${unique}`, type: 'LLC' } })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Unrouted ${label}-${unique}`,
      addressLine1: '1 Stray St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({ data: { firstName: 'Casey', lastName: `${label}-${unique}` } })
  const lease = await prisma.lease.create({
    data: { propertyId: property.id, unitId: unit.id, status: 'ACTIVE', startsOn: new Date('2026-01-01'), rentCents: 150_000 },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  return { property, tenant }
}

async function staff(grants: Array<{ role: string; propertyId?: string }>) {
  const user = await prisma.staffUser.create({
    data: { email: `unrouted-${randomUUID()}@example.test`, name: 'Unrouted Test' },
  })
  staffIds.push(user.id)
  for (const grant of grants) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: grant.role } })
    await prisma.staffAssignment.create({
      data: { staffUserId: user.id, roleId: role.id, propertyId: grant.propertyId },
    })
  }
  return user.id
}

async function stray() {
  const row = await prisma.unroutedMessage.create({
    data: {
      channel: 'SMS',
      fromAddress: `+1555${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`,
      body: `who is this ${randomUUID()}`,
      reason: 'UNKNOWN_SENDER',
      receivedAt: new Date(),
    },
  })
  unroutedIds.push(row.id)
  return row
}

async function fileAs(staffId: string, unroutedId: string, tenantId: string) {
  session.staffId = staffId
  const form = new FormData()
  form.set('tenantId', tenantId)
  return fileUnroutedMessage(unroutedId, {}, form)
}

async function routedAt(id: string) {
  return (await prisma.unroutedMessage.findUniqueOrThrow({ where: { id } })).routedAt
}

let a: Awaited<ReturnType<typeof house>>
let b: Awaited<ReturnType<typeof house>>
let oneHouse: string
let portfolio: string
let readEverywhereSendOnA: string

beforeAll(async () => {
  a = await house('A')
  b = await house('B')
  oneHouse = await staff([{ role: 'manager', propertyId: a.property.id }])
  portfolio = await staff([{ role: 'manager' }])
  // Reads the whole portfolio, but may only SEND at house A.
  readEverywhereSendOnA = await staff([{ role: 'read_only' }, { role: 'manager', propertyId: a.property.id }])
})

afterAll(async () => {
  // Filed rows point at append-only Messages; leave them, retire the rest.
  await prisma.unroutedMessage.deleteMany({ where: { id: { in: unroutedIds }, routedAt: null } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
})

describe('SEC-16: the unrouted inbox is portfolio-wide only', () => {
  it('a one-house manager sees no unrouted messages and no count', async () => {
    const row = await stray()
    const actor = (await loadStaffActor(oneHouse, true))!
    expect(await listUnroutedMessages(actor, 10_000)).toEqual([])
    expect(await unroutedCount(actor)).toBe(0)
    expect(row.routedAt).toBeNull()
  })

  it('portfolio-wide staff see them', async () => {
    const row = await stray()
    const actor = (await loadStaffActor(portfolio, true))!
    const listed = await listUnroutedMessages(actor, 10_000)
    expect(listed.map((m) => m.id)).toContain(row.id)
    expect(await unroutedCount(actor)).toBeGreaterThan(0)
  })

  it('a one-house manager cannot file, even into their own house', async () => {
    const row = await stray()
    await expect(fileAs(oneHouse, row.id, a.tenant.id)).rejects.toThrow('REDIRECT /no-access')
    expect(await routedAt(row.id)).toBeNull()
  })

  it('filing into a house outside the send scope is refused', async () => {
    const row = await stray()
    await expect(fileAs(readEverywhereSendOnA, row.id, b.tenant.id)).rejects.toThrow('REDIRECT /no-access')
    expect(await routedAt(row.id)).toBeNull()
  })

  it('portfolio-wide read is not enough to file: send must be portfolio-wide too', async () => {
    const row = await stray()
    await expect(fileAs(readEverywhereSendOnA, row.id, a.tenant.id)).rejects.toThrow('REDIRECT /no-access')
    expect(await routedAt(row.id)).toBeNull()
  })

  it('portfolio-wide staff file it into the tenant thread', async () => {
    const row = await stray()
    await expect(fileAs(portfolio, row.id, b.tenant.id)).rejects.toThrow('REDIRECT /messages/')
    expect(await routedAt(row.id)).not.toBeNull()
  })
})
