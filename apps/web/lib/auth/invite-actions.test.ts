import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { INVITE_REFUSED } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// R-304a (PRD 11 §4.5, §4.17): the console creates an org and its owner's
// invite, and the invite is accepted on that org's host. Driven through the
// real actions with only the request, the platform guard, the send and the
// redirect replaced.

const BASE = 'r304.test'
const request = vi.hoisted(() => ({ host: 'localhost:3100' }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: request.host, 'x-forwarded-for': '10.30.4.1' }),
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
class Redirected extends Error {}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to)
  },
}))
const ADMIN = { id: `plat-${randomUUID()}`, name: 'Console Tester' }
vi.mock('@/lib/platform/guard.ts', () => ({ requirePlatform: async () => ADMIN }))
const sent = vi.hoisted(() => [] as { to: string; body: string; orgId: string | null }[])
vi.mock('@/lib/notifications/deliver.ts', () => ({
  deliverOverChannel: async (args: { to: string; body: string; orgId: string | null }) => {
    sent.push(args)
    return { status: 'SENT' }
  },
}))

const { createOrganization, manageOrgInvite } = await import('@/lib/platform/org-actions.ts')
const { acceptOrgInvite } = await import('./invite-actions.ts')

const stamp = `r304-${randomUUID().slice(0, 8)}`
const PASSWORD = 'correct horse battery staple'
const createdOrgs: string[] = []
const createdUsers: string[] = []

const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}
const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!

async function accept(host: string, token: string, password?: string) {
  request.host = host
  try {
    return await acceptOrgInvite({}, form({ token, ...(password && { password, confirmPassword: password }) }))
  } catch (error) {
    if (error instanceof Redirected) return { redirected: error.message }
    throw error
  }
}

async function create(slug: string, ownerEmail: string) {
  const state = await createOrganization(
    {},
    form({ name: `${slug} Homes`, slug, ownerName: 'Olive Owner', ownerEmail }),
  )
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } })
  if (org) createdOrgs.push(org.id)
  return { state, orgId: org?.id ?? '' }
}

async function isOwner(orgId: string, email: string) {
  const user = await prisma.staffUser.findUniqueOrThrow({ where: { email } })
  createdUsers.push(user.id)
  const membership = await prisma.orgMembership.findUnique({
    where: { orgId_staffUserId: { orgId, staffUserId: user.id } },
  })
  const grants = await prisma.staffAssignment.count({
    where: { orgId, staffUserId: user.id, revokedAt: null, role: { key: 'owner' }, propertyId: null, legalEntityId: null },
  })
  return { user, live: membership?.removedAt === null && grants === 1 }
}

beforeAll(() => {
  vi.stubEnv('ORG_BASE_DOMAIN', BASE)
  vi.stubEnv('AUTH_URL', 'http://localhost:3100')
})

afterAll(async () => {
  // Memberships and grants can be retired, never the audited rows behind them.
  await prisma.staffAssignment.updateMany({ where: { staffUserId: { in: createdUsers } }, data: { revokedAt: new Date() } })
  await prisma.staffUser.updateMany({ where: { id: { in: createdUsers } }, data: { active: false } })
  vi.unstubAllEnvs()
})

describe('createOrganization (PRD 11 §4.5)', () => {
  it('creates the org and its invite, audits both in the new org, and mails a link on the org host', async () => {
    const slug = `${stamp}-a`
    const { state, orgId } = await create(slug, `${stamp}-a@owner.test`)
    expect(state.error).toBeUndefined()
    expect(state.setupUrl).toMatch(new RegExp(`^http://${slug}\\.${BASE.replace('.', '\\.')}:3100/invite/`))

    const invite = await prisma.orgInvite.findFirstOrThrow({ where: { orgId } })
    expect(invite).toMatchObject({ email: `${stamp}-a@owner.test`, roleKey: 'owner', invitedByType: 'PLATFORM', invitedById: ADMIN.id })
    // Hashed: the token in the link is not what the row stores.
    expect(invite.tokenHash).not.toBe(tokenOf(state.setupUrl!))
    expect(invite.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3_600_000)

    const actions = await prisma.auditLog.findMany({ where: { orgId, actorType: 'PLATFORM' }, select: { action: true } })
    expect(actions.map((a) => a.action).sort()).toEqual(['org.created', 'org_invite.sent'])
    expect(sent.at(-1)).toMatchObject({ to: invite.email, orgId })
    expect(sent.at(-1)!.body).toContain(state.setupUrl!)
    // The page never creates an account; acceptance does.
    expect(await prisma.staffUser.findUnique({ where: { email: invite.email } })).toBeNull()
  })

  it('refuses a malformed, reserved or taken slug, and creates nothing', async () => {
    for (const slug of ['Bad Slug', 'www', 'platform']) {
      const { state } = await create(slug, `${stamp}-x@owner.test`)
      expect(state.fieldErrors?.slug).toBeTruthy()
    }
    const { state } = await create(`${stamp}-a`, `${stamp}-x@owner.test`)
    expect(state.error).toMatch(/is taken/)
    expect(await prisma.orgInvite.count({ where: { email: `${stamp}-x@owner.test` } })).toBe(0)
  })
})

describe('acceptOrgInvite (PRD 11 §4.17)', () => {
  it('creates the account, the membership and the owner grant, once, on the org host only', async () => {
    const slug = `${stamp}-b`
    const email = `${stamp}-b@owner.test`
    const { state, orgId } = await create(slug, email)
    const token = tokenOf(state.setupUrl!)

    // Another org's host, and the bare default host, answer as a bad link does.
    expect(await accept(`${stamp}-a.${BASE}`, token, PASSWORD)).toEqual({ error: INVITE_REFUSED })
    expect(await accept('localhost:3100', token, PASSWORD)).toEqual({ error: INVITE_REFUSED })
    expect(await accept(`${slug}.${BASE}`, 'no-such-token', PASSWORD)).toEqual({ error: INVITE_REFUSED })
    expect(await prisma.staffUser.findUnique({ where: { email } })).toBeNull()

    expect(await accept(`${slug}.${BASE}`, token, 'short')).toMatchObject({ error: expect.stringMatching(/characters/) })
    expect(await accept(`${slug}.${BASE}`, token, PASSWORD)).toEqual({ redirected: '/login?invited=1' })
    const { user, live } = await isOwner(orgId, email)
    expect(live).toBe(true)
    expect(user.name).toBe('Olive Owner')
    const invite = await prisma.orgInvite.findFirstOrThrow({ where: { orgId } })
    expect(invite.acceptedById).toBe(user.id)
    expect(await prisma.auditLog.count({ where: { orgId, action: 'org_invite.accepted', actorRef: user.id } })).toBe(1)

    // Single use.
    expect(await accept(`${slug}.${BASE}`, token, PASSWORD)).toEqual({ error: INVITE_REFUSED })
  })

  it('joins an existing account without touching its password', async () => {
    const email = `${stamp}-c@owner.test`
    const existing = await prisma.staffUser.create({
      data: { email, name: 'Already Here', credential: { create: { passwordHash: await hashPassword(PASSWORD) } } },
      include: { credential: true },
    })
    createdUsers.push(existing.id)
    const slug = `${stamp}-c`
    const { state, orgId } = await create(slug, email)

    expect(await accept(`${slug}.${BASE}`, tokenOf(state.setupUrl!))).toEqual({ redirected: '/login?invited=1' })
    const { user, live } = await isOwner(orgId, email)
    expect(live).toBe(true)
    expect(user.id).toBe(existing.id)
    expect(user.name).toBe('Already Here')
    const credential = await prisma.staffCredential.findUniqueOrThrow({ where: { staffUserId: existing.id } })
    expect(credential.passwordHash).toBe(existing.credential!.passwordHash)
  })

  it('refuses a revoked invite, an expired one, and the link a resend replaced', async () => {
    const slug = `${stamp}-d`
    const { state, orgId } = await create(slug, `${stamp}-d@owner.test`)
    const invite = await prisma.orgInvite.findFirstOrThrow({ where: { orgId } })

    const resent = await manageOrgInvite({}, form({ slug, inviteId: invite.id, intent: 'resend' }))
    expect(resent.setupUrl).toBeTruthy()
    expect(await accept(`${slug}.${BASE}`, tokenOf(state.setupUrl!), PASSWORD)).toEqual({ error: INVITE_REFUSED })

    await prisma.orgInvite.update({ where: { id: invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await accept(`${slug}.${BASE}`, tokenOf(resent.setupUrl!), PASSWORD)).toEqual({ error: INVITE_REFUSED })

    await prisma.orgInvite.update({ where: { id: invite.id }, data: { expiresAt: new Date(Date.now() + 3_600_000) } })
    expect((await manageOrgInvite({}, form({ slug, inviteId: invite.id, intent: 'revoke' }))).notice).toMatch(/revoked/)
    expect(await accept(`${slug}.${BASE}`, tokenOf(resent.setupUrl!), PASSWORD)).toEqual({ error: INVITE_REFUSED })

    const actions = await prisma.auditLog.findMany({ where: { orgId, entityId: invite.id }, select: { action: true } })
    expect(actions.map((a) => a.action).sort()).toEqual(['org_invite.revoked', 'org_invite.sent', 'org_invite.sent'])
    expect(await prisma.staffUser.findUnique({ where: { email: `${stamp}-d@owner.test` } })).toBeNull()
  })
})
