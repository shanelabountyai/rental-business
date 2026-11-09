import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { replyInThread } from '@/lib/comms/actions.ts'
import { resolveThread } from '@/lib/comms/threads.ts'

// R-267 (OQ-15, D-404): without `message.send_freeform` a staff reply to a
// tenant is a managed template, never the typed body. Session mocked, the
// grant and the RBAC decision real - same seam as jurisdiction/actions.test.ts.

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
const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [k, v] of Object.entries(fields)) data.set(k, v)
  return data
}
let techId = ''
let managerId = ''
let propertyId = ''
let threadId = ''
let templateId = ''

async function staff(roleKey: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  return (
    await prisma.staffUser.create({
      data: {
        email: `tpl-${roleKey}-${unique}@example.test`,
        name: `Tpl ${roleKey}`,
        orgMemberships: { create: { orgId: 'org_0' } },
        assignments: { create: { orgId: 'org_0', roleId: role.id } },
      },
    })
  ).id
}

async function messagesInThread() {
  return prisma.message.findMany({ where: { threadId }, select: { body: true, staffUserId: true } })
}

beforeAll(async () => {
  ;[techId, managerId] = await Promise.all([staff('maintenance_tech'), staff('manager')])
  const entity = await prisma.legalEntity.create({ data: { orgId: 'org_0', name: `Tpl ${unique}`, type: 'LLC' } })
  propertyId = (
    await prisma.property.create({
      data: {
        legalEntityId: entity.id,
        name: `Tpl ${unique}`,
        addressLine1: '1 Test St',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
  ).id
  const unit = await prisma.unit.create({ data: { propertyId, name: `U-${unique}`, status: 'OCCUPIED' } })
  const tenant = await prisma.tenant.create({ data: { orgId: 'org_0', firstName: 'Tpl', lastName: unique } })
  const lease = await prisma.lease.create({
    data: { propertyId, unitId: unit.id, status: 'ACTIVE', startsOn: new Date('2026-01-01'), rentCents: 150_000 },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  threadId = (await resolveThread({ scope: 'TENANT', propertyId, tenantId: tenant.id })).id
  templateId = (
    await prisma.messageTemplate.create({
      data: {
        orgId: 'org_0',
        name: `Visit confirmed ${unique}`,
        kind: 'ROUTINE',
        body: `Your maintenance visit is confirmed (${unique}).`,
        createdByStaffId: managerId,
      },
    })
  ).id
})

afterAll(async () => {
  // Message is append-only: retire what carries it rather than delete.
  await prisma.messageTemplate.updateMany({ where: { id: templateId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.staffAssignment.updateMany({ where: { staffUserId: { in: [techId, managerId] } }, data: { revokedAt: new Date() } })
  await prisma.staffUser.updateMany({ where: { id: { in: [techId, managerId] } }, data: { active: false } })
})

describe('template-only staff replies (R-267)', () => {
  it('refuses free text from a sender without message.send_freeform', async () => {
    session.staffId = techId
    const result = await replyInThread(threadId, {}, form({ channel: 'PORTAL', body: 'anything I like' }))
    expect(result).toEqual({ error: 'Choose a template to send.' })
    expect(await messagesInThread()).toEqual([])
  })

  it('sends the rendered template and ignores a typed body alongside it', async () => {
    session.staffId = techId
    await expect(
      replyInThread(threadId, {}, form({ channel: 'PORTAL', templateId, body: 'smuggled free text' })),
    ).rejects.toThrow(`REDIRECT /messages/${threadId}`)
    expect(await messagesInThread()).toEqual([
      { body: `Your maintenance visit is confirmed (${unique}).`, staffUserId: techId },
    ])
  })

  it('lets a manager write their own words', async () => {
    session.staffId = managerId
    await expect(
      replyInThread(threadId, {}, form({ channel: 'PORTAL', body: `In my own words ${unique}` })),
    ).rejects.toThrow('REDIRECT')
    expect(await messagesInThread()).toContainEqual({ body: `In my own words ${unique}`, staffUserId: managerId })
  })
})
