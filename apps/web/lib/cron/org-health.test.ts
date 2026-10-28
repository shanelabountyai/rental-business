import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { attentionReasons } from '@/lib/platform/orgs.ts'
import { orgHealthCounts, recordOrgHealth } from './org-health.ts'

vi.mock('server-only', () => ({}))

const orgId = `org_health_${randomUUID().slice(0, 8)}`

afterAll(async () => {
  await prisma.orgHealth.deleteMany({ where: { orgId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('OrgHealth (R-303, D-354)', () => {
  it('carries no free text: counts, and two-letter state codes only', async () => {
    // org #0 holds every fixture's properties, so `states` is not empty here.
    const counts = await orgHealthCounts('org_0', new Date())
    for (const [key, value] of Object.entries(counts)) {
      if (key === 'states') {
        for (const state of value as string[]) expect(state).toMatch(/^[A-Z]{2}$/)
      } else expect(Number.isInteger(value), key).toBe(true)
    }
  })

  it('keeps each child’s outcome when another child writes', async () => {
    await prisma.organization.create({ data: { id: orgId, slug: orgId.replaceAll('_', '-'), name: 'Health test' } })
    const daily = new Date('2026-10-28T16:00:00Z')
    const hourly = new Date('2026-10-28T17:00:00Z')
    await recordOrgHealth(orgId, 'daily', false, daily)
    await recordOrgHealth(orgId, 'notifications', true, hourly)
    const row = await prisma.orgHealth.findUniqueOrThrow({ where: { orgId } })
    expect(row).toMatchObject({
      computedAt: hourly,
      dailyAt: daily,
      dailyOk: false,
      notificationsAt: hourly,
      notificationsOk: true,
      escalationsAt: null,
      activeOwners: 0,
      properties: 0,
      states: [],
    })
  })
})

describe('attentionReasons (PRD 11 §4.2)', () => {
  const now = new Date('2026-10-28T18:00:00Z')
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000)
  const healthy = { computedAt: hoursAgo(1), dailyAt: hoursAgo(2), dailyOk: true, deadLetters: 0 }
  const org = (over: Partial<Parameters<typeof attentionReasons>[0]> = {}) => ({
    notificationsEnabled: true,
    health: healthy,
    integrations: [],
    ...over,
  })

  it('lists nothing for a healthy org', () => {
    expect(attentionReasons(org(), now)).toEqual([])
  })

  it('reads stale health as a dead cron, never as its old numbers', () => {
    expect(attentionReasons(org({ health: null }), now)).toEqual(['Health not yet reported'])
    expect(attentionReasons(org({ health: { ...healthy, computedAt: hoursAgo(27), deadLetters: 3 } }), now)).toEqual([
      'Health not reported in over 26 hours',
    ])
  })

  it('names a failed or missing daily run, dead letters, a broken integration and the kill switch', () => {
    expect(attentionReasons(org({ health: { ...healthy, dailyOk: false } }), now)).toEqual(['Last daily run failed'])
    expect(attentionReasons(org({ health: { ...healthy, dailyAt: null } }), now)).toEqual([
      'Daily run has not run in over 26 hours',
    ])
    expect(
      attentionReasons(
        org({
          health: { ...healthy, deadLetters: 1 },
          integrations: [
            { provider: 'TWILIO', status: 'FAILED' },
            { provider: 'STRIPE', status: 'ACTIVE' },
          ],
          notificationsEnabled: false,
        }),
        now,
      ),
    ).toEqual(['1 dead-lettered event', 'Twilio failed', 'Notifications switched off'])
  })
})
