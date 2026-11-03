import { prisma } from '@rental/db'
import { afterAll, describe, expect, it } from 'vitest'
import { clearExpiredFinalExports, runOffboarding } from './offboard.ts'

// R-300b: the offboard run against the real schema - the evidence closure
// keeps what an audit row points at, the rest goes, the people are blanked,
// and the final export's link and credential outlive the purge only until
// the link expires.

const stamp = `offboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const DAY = 24 * 60 * 60_000

afterAll(async () => {
  await prisma.organization.updateMany({ where: { slug: { startsWith: stamp } }, data: { notificationsEnabled: false } })
})

async function dueOrg() {
  const frozenAt = new Date(Date.now() - 91 * DAY)
  const org = await prisma.organization.create({
    data: { slug: stamp, name: 'Offboard Co', status: 'FROZEN', frozenAt, offboardAt: new Date(Date.now() - DAY) },
  })
  const entity = await prisma.legalEntity.create({ data: { orgId: org.id, name: 'Offboard LLC', type: 'LLC' } })
  const property = (name: string) =>
    prisma.property.create({
      data: {
        orgId: org.id,
        legalEntityId: entity.id,
        name,
        addressLine1: `1 ${name} St`,
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
  const [evidenced, bare] = [await property('Evidenced'), await property('Bare')]
  // An append-only row pointing at one property is what keeps it.
  await prisma.auditLog.create({
    data: { orgId: org.id, propertyId: evidenced.id, actorType: 'SYSTEM', actorRef: 'test', entityType: 'Property', entityId: evidenced.id, action: 'property.created' },
  })
  const tenant = await prisma.tenant.create({ data: { orgId: org.id, firstName: 'Ada', lastName: 'Lovelace', email: `${stamp}-t@example.test`, phone: '+15125550100' } })

  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  const owner = await prisma.staffUser.create({
    data: { email: `${stamp}-owner@example.test`, name: 'Olive Owner', phone: '+15125550101', credential: { create: { passwordHash: 'x' } } },
  })
  const manager = await prisma.staffUser.create({
    data: { email: `${stamp}-mgr@example.test`, name: 'Manny Manager', credential: { create: { passwordHash: 'x' } } },
  })
  await prisma.orgMembership.createMany({ data: [{ orgId: org.id, staffUserId: owner.id }, { orgId: org.id, staffUserId: manager.id }] })
  await prisma.staffAssignment.create({ data: { orgId: org.id, staffUserId: owner.id, roleId: role.id } })
  return { orgId: org.id, evidenced: evidenced.id, bare: bare.id, tenant: tenant.id, owner: owner.id, manager: manager.id }
}

describe('runOffboarding', () => {
  it('exports, emails the owner, purges outside the evidence, blanks the people, and is OFFBOARDED', async () => {
    const f = await dueOrg()
    const result = await runOffboarding(f.orgId)
    expect(result).toMatchObject({ ok: true, stage: 'offboarded' })

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: f.orgId } })
    expect(org.status).toBe('OFFBOARDED')
    // Kept because an audit row points at it; the other had nothing.
    expect(await prisma.property.findUnique({ where: { id: f.evidenced } })).not.toBeNull()
    expect(await prisma.property.findUnique({ where: { id: f.bare } })).toBeNull()
    expect(await prisma.tenant.findUnique({ where: { id: f.tenant } })).toBeNull()
    expect(await prisma.orgMembership.count({ where: { orgId: f.orgId } })).toBe(0)

    const owner = await prisma.staffUser.findUniqueOrThrow({ where: { id: f.owner }, include: { credential: true } })
    expect([owner.name, owner.phone, owner.email]).toEqual(['Former staff member', null, `former-${f.owner}@offboarded.invalid`])
    // The owner's code is still checkable for the link; the manager's is gone.
    expect(owner.credential).not.toBeNull()
    expect(await prisma.staffCredential.findUnique({ where: { staffUserId: f.manager } })).toBeNull()

    const link = await prisma.finalExportLink.findUniqueOrThrow({ where: { orgId_staffUserId: { orgId: f.orgId, staffUserId: f.owner } } })
    const sent = await prisma.notification.findMany({ where: { orgId: f.orgId, idempotencyKey: { startsWith: `final-export:${f.orgId}:` } } })
    expect(sent).toHaveLength(1)

    const audit = await prisma.auditLog.findMany({ where: { orgId: f.orgId, action: 'org.offboarded' } })
    expect(audit).toHaveLength(1)

    // Again: nothing is due until the link expires, and nothing is re-sent.
    expect(await runOffboarding(f.orgId)).toEqual({ ok: true, skipped: 'nothing_expired' })

    const cleared = await clearExpiredFinalExports(f.orgId, new Date(link.expiresAt.getTime() + 1))
    expect(cleared).toMatchObject({ ok: true, links: 1 })
    expect(await prisma.finalExportLink.count({ where: { orgId: f.orgId } })).toBe(0)
    expect(await prisma.staffCredential.findUnique({ where: { staffUserId: f.owner } })).toBeNull()
  })
})
