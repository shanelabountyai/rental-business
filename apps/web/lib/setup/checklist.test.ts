import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { recordOrgHealth } from '@/lib/cron/org-health.ts'
import { type SetupFacts, isChecklist, readyToGoLive, setupChecklist, setupFacts, stepReason } from './checklist.ts'

vi.mock('server-only', () => ({}))

const done: SetupFacts = {
  status: 'PROVISIONING',
  marks: ['templates_reviewed'],
  activeOwners: 1,
  activeMembers: 2,
  entities: 1,
  properties: 3,
  templates: 4,
  stripe: { status: 'ENABLED', statusReason: null },
  twilio: { status: 'ACTIVE', statusReason: null },
  resend: { status: 'VERIFIED', statusReason: null },
  unreviewedStates: [],
  testText: true,
  testPayment: true,
}

describe('setupChecklist (PRD 10 §5, R-291a)', () => {
  it('is ready to go live with every fact in place, and live only once ACTIVE', () => {
    const c = setupChecklist(done)
    expect(readyToGoLive(c)).toBe(true)
    expect(c.live).toBe(false)
    expect(setupChecklist({ ...done, status: 'ACTIVE' }).live).toBe(true)
  })

  it('takes the owner’s word for "just me" and the shared domain, never for a provider', () => {
    expect(setupChecklist({ ...done, activeMembers: 1 }).users).toBe(false)
    expect(setupChecklist({ ...done, activeMembers: 1, marks: ['just_me'] }).users).toBe(true)
    expect(setupChecklist({ ...done, resend: null }).email).toBe(false)
    expect(setupChecklist({ ...done, resend: null, marks: ['shared_email'] }).email).toBe(true)
    expect(setupChecklist({ ...done, stripe: { status: 'RESTRICTED', statusReason: null } }).stripe).toBe(false)
  })

  it('refuses go-live on any one missing step', () => {
    const misses: Partial<SetupFacts>[] = [
      { activeOwners: 0 },
      { entities: 0 },
      { marks: [] },
      { twilio: { status: 'PROVISIONING', statusReason: null } },
      { unreviewedStates: ['OK'] },
      { properties: 0 },
      { testText: false },
      { testPayment: false },
    ]
    for (const miss of misses) expect(readyToGoLive(setupChecklist({ ...done, ...miss })), JSON.stringify(miss)).toBe(false)
  })

  it('names the provider’s reason verbatim and the unreviewed states', () => {
    const f = { ...done, twilio: { status: 'FAILED', statusReason: 'Campaign rejected: sample messages missing.' }, unreviewedStates: ['OK'] }
    const c = setupChecklist(f)
    expect(stepReason('sms', f, c)).toBe('Texting is failed. Campaign rejected: sample messages missing.')
    expect(stepReason('jurisdiction', f, c)).toContain('OK')
    expect(stepReason('stripe', f, c)).toBeNull()
  })
})

describe('setupFacts against the database', () => {
  const orgId = `org_setup_${randomUUID().slice(0, 8)}`
  afterAll(async () => {
    await prisma.orgHealth.deleteMany({ where: { orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  it('starts a new org PROVISIONING with nothing done, and writes only booleans to OrgHealth', async () => {
    await prisma.organization.create({ data: { id: orgId, slug: orgId.replaceAll('_', '-'), name: 'Setup test' } })
    const facts = await setupFacts(orgId)
    expect(facts.status).toBe('PROVISIONING')
    expect(Object.values(setupChecklist(facts)).some(Boolean)).toBe(false)

    await recordOrgHealth(orgId, null, true)
    const { checklist } = await prisma.orgHealth.findUniqueOrThrow({ where: { orgId }, select: { checklist: true } })
    expect(isChecklist(checklist)).toBe(true)
    for (const value of Object.values(checklist as object)) expect(typeof value).toBe('boolean')
  })
})
