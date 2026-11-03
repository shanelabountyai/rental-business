import { recordAudit } from '@rental/core/audit'
import { prisma } from '@rental/db'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cronRoute } from '@/lib/cron/per-org.ts'
import { type LifecycleAudit, freezeOrg, restoreOrg, scheduleOffboarding } from './lifecycle.ts'

// R-300a: the transitions against the real CHECKs, and a frozen org's cron
// child doing nothing.

const stamp = `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const orgIds: string[] = []
const auditFor =
  (orgId: string): LifecycleAudit =>
  (tx, entry) =>
    recordAudit(tx, { actor: { type: 'SYSTEM', ref: 'test' }, entityType: 'Organization', entityId: orgId, orgId, ...entry })

async function liveOrg(tag: string) {
  const org = await prisma.organization.create({ data: { slug: `${stamp}-${tag}`, name: `Lifecycle ${tag}`, status: 'ACTIVE' } })
  orgIds.push(org.id)
  return org.id
}

afterEach(() => {
  delete process.env.CRON_SECRET
})

afterAll(async () => {
  // Retired, not deleted: their audit rows are append-only (CLAUDE.md).
  await prisma.organization.updateMany({ where: { id: { in: orgIds } }, data: { notificationsEnabled: false } })
})

describe('freeze, schedule, restore', () => {
  it('moves ACTIVE → FROZEN once, counts the window from the freeze, and restores', async () => {
    const orgId = await liveOrg('a')
    const audit = auditFor(orgId)

    expect(await freezeOrg(orgId, 'platform', 'Moving to another system', audit)).toEqual({ ok: true })
    const frozen = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
    expect(frozen.status).toBe('FROZEN')
    expect(frozen.frozenAt).not.toBeNull()
    expect(await freezeOrg(orgId, 'platform', 'again', audit)).toEqual({ ok: false, error: 'The organisation is already frozen.' })

    const scheduled = await scheduleOffboarding(orgId, 'Confirmed by the owner', audit)
    expect(scheduled.ok).toBe(true)
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
    expect(after.offboardAt!.getTime() - frozen.frozenAt!.getTime()).toBe(90 * 24 * 60 * 60_000)
    expect((await scheduleOffboarding(orgId, 'twice', audit)).ok).toBe(false)

    expect(await restoreOrg(orgId, 'Changed their mind', audit)).toEqual({ ok: true })
    const restored = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
    expect([restored.status, restored.frozenAt, restored.offboardAt]).toEqual(['ACTIVE', null, null])

    const actions = await prisma.auditLog.findMany({ where: { orgId, entityId: orgId }, orderBy: { occurredAt: 'asc' }, select: { action: true } })
    expect(actions.map((a) => a.action)).toEqual(['org.frozen', 'org.offboard_scheduled', 'org.restored'])
  })

  it('refuses to freeze an org still being set up', async () => {
    const org = await prisma.organization.create({ data: { slug: `${stamp}-p`, name: 'Lifecycle p' } })
    orgIds.push(org.id)
    const outcome = await freezeOrg(org.id, 'owner', null, auditFor(org.id))
    expect(outcome.ok).toBe(false)
  })

  it('the database refuses a FROZEN org with no freeze date', async () => {
    const orgId = await liveOrg('c')
    await expect(prisma.organization.update({ where: { id: orgId }, data: { status: 'FROZEN' } })).rejects.toThrow(/frozenAt_check/)
    await expect(prisma.organization.update({ where: { id: orgId }, data: { offboardAt: new Date() } })).rejects.toThrow(/offboardAt_check/)
  })
})

describe('crons skip a frozen org', () => {
  it('answers the child without running it', async () => {
    const orgId = await liveOrg('d')
    await freezeOrg(orgId, 'platform', 'test', auditFor(orgId))
    process.env.CRON_SECRET = 'a-secret-of-known-length'
    let ran = false
    const response = await cronRoute(
      new Request(`http://localhost/api/cron?org=${orgId}`, { headers: { authorization: 'Bearer a-secret-of-known-length' } }),
      'daily',
      async () => {
        ran = true
        return { ok: true }
      },
    )
    expect(await response.json()).toEqual({ ok: true, skipped: 'FROZEN' })
    expect(ran).toBe(false)
  })
})
