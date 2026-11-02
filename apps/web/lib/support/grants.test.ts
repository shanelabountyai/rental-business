import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { expireSupportGrants, notifyOwnersOfGrant, unacknowledgedBreakGlass } from './grants.ts'

// PLAT-10 (PRD 11 §7.1, R-295a): break-glass notifies every ACTIVE owner and
// shows the banner until one is acknowledged. Against the real database,
// because "active owner" is a join across membership, grant and role.
//
// Each org is this file's own (a fresh slug), so nothing here reads another
// file's rows. Notifications are append-only, so the orgs stay; their staff
// are deactivated afterwards.

vi.stubEnv('AUTH_URL', process.env.AUTH_URL || 'http://localhost:3100')

const staffIds: string[] = []
afterAll(async () => {
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

async function fixture(notificationsEnabled = true) {
  const tag = randomUUID().slice(0, 8)
  const org = await prisma.organization.create({
    data: { slug: `plat10-${tag}`, name: `Plat10 ${tag}`, notificationsEnabled },
  })
  const owner = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  const staff = async (name: string) => {
    const s = await prisma.staffUser.create({
      data: {
        email: `plat10-${tag}-${name}@example.test`,
        name: `${name} ${tag}`,
        orgMemberships: { create: { orgId: org.id } },
        assignments: { create: { orgId: org.id, roleId: owner.id } },
      },
    })
    staffIds.push(s.id)
    return s
  }
  const a = await staff('owner-a')
  const b = await staff('owner-b')
  const removed = await staff('removed')
  // Removed from the org: the membership and the grant both end.
  await prisma.$transaction([
    prisma.staffAssignment.updateMany({ where: { staffUserId: removed.id }, data: { revokedAt: new Date() } }),
    prisma.orgMembership.update({ where: { orgId_staffUserId: { orgId: org.id, staffUserId: removed.id } }, data: { removedAt: new Date() } }),
  ])
  const admin = await prisma.platformAdmin.create({ data: { email: `plat10-${tag}@example.test`, name: `Support ${tag}` } })
  return { org, a, b, removed, admin, owner }
}

async function breakGlass(orgId: string, platformAdminId: string) {
  const now = new Date()
  return prisma.supportAccessGrant.create({
    data: {
      orgId,
      platformAdminId,
      kind: 'BREAK_GLASS',
      reason: 'Payments webhook is failing for every lease',
      requestedMinutes: 60,
      startsAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
    },
  })
}

/// THE CHECK: which staff got a `support_access` notification for this grant.
async function recipients(grantId: string) {
  const rows = await prisma.notification.findMany({
    where: { category: 'support_access', idempotencyKey: { startsWith: `support-grant:${grantId}:` } },
    select: { recipientId: true, orgId: true, delivery: { select: { status: true, suppressedReason: true } } },
  })
  return rows
}

describe('PLAT-10: break-glass notifies every active owner and shows the banner', () => {
  it('tells both owners, never the removed member, and keeps the banner until one owner presses Seen', async () => {
    const { org, a, b, removed, admin } = await fixture()
    const grant = await breakGlass(org.id, admin.id)
    await notifyOwnersOfGrant(grant.id)

    const rows = await recipients(grant.id)
    expect(new Set(rows.map((r) => r.recipientId))).toEqual(new Set([a.id, b.id]))
    expect(rows.some((r) => r.recipientId === removed.id)).toBe(false)
    // Filed in the grant's org, not org #0, with no property to derive it from.
    expect(new Set(rows.map((r) => r.orgId))).toEqual(new Set([org.id]))

    expect((await unacknowledgedBreakGlass(org.id)).map((g) => g.id)).toEqual([grant.id])
    await prisma.supportAccessGrant.update({
      where: { id: grant.id },
      data: { ownersAcknowledgedAt: new Date(), acknowledgedByStaffId: a.id },
    })
    expect(await unacknowledgedBreakGlass(org.id)).toEqual([])
  })

  it('control: the same check counts the third member once they are an owner again', async () => {
    const { org, removed, admin, owner } = await fixture()
    await prisma.orgMembership.update({
      where: { orgId_staffUserId: { orgId: org.id, staffUserId: removed.id } },
      data: { removedAt: null },
    })
    await prisma.staffAssignment.create({ data: { staffUserId: removed.id, orgId: org.id, roleId: owner.id } })
    const grant = await breakGlass(org.id, admin.id)
    await notifyOwnersOfGrant(grant.id)
    expect(new Set((await recipients(grant.id)).map((r) => r.recipientId)).size).toBe(3)
  })

  it('holds the notice while the org is switched off, rather than suppressing it (D-359, D-380)', async () => {
    const { org, admin } = await fixture(false)
    const grant = await breakGlass(org.id, admin.id)
    await notifyOwnersOfGrant(grant.id)
    const rows = await recipients(grant.id)
    // EMAIL is addressable; nothing went out, and nothing was thrown away.
    const email = rows.flatMap((r) => r.delivery ?? []).filter((d) => d.suppressedReason !== 'no_address')
    expect(email.length).toBeGreaterThan(0)
    expect(email.every((d) => d.status === 'QUEUED')).toBe(true)
  })
})

describe('expireSupportGrants', () => {
  it('stamps EXPIRY on a grant past its window and leaves a live one', async () => {
    const { org, admin } = await fixture()
    const now = new Date()
    const live = await breakGlass(org.id, admin.id)
    const other = await prisma.platformAdmin.create({ data: { email: `plat10-exp-${randomUUID()}@example.test`, name: 'Other' } })
    const past = await prisma.supportAccessGrant.create({
      data: {
        orgId: org.id,
        platformAdminId: other.id,
        kind: 'REQUESTED',
        reason: 'An old request that was approved',
        requestedMinutes: 60,
        approvedAt: new Date(now.getTime() - 3 * 3600_000),
        approvedByStaffId: (await prisma.staffUser.findFirstOrThrow({ where: { email: { startsWith: `plat10-${org.slug.slice(7)}-owner-a` } } })).id,
        startsAt: new Date(now.getTime() - 3 * 3600_000),
        expiresAt: new Date(now.getTime() - 2 * 3600_000),
      },
    })
    expect(await expireSupportGrants(org.id)).toBe(1)
    const [after, still] = await Promise.all([
      prisma.supportAccessGrant.findUniqueOrThrow({ where: { id: past.id } }),
      prisma.supportAccessGrant.findUniqueOrThrow({ where: { id: live.id } }),
    ])
    expect(after.endedByType).toBe('EXPIRY')
    expect(still.endedAt).toBeNull()
  })
})
