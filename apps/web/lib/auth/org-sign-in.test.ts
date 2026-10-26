import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// R-288 (PRD 10 §1.4): the host names the org, and sign-in happens inside it.
// Two orgs share a renter's email and a staff member belongs to one of them -
// the exact day-one shape of org #2 - and every flow is driven through the
// real action with only the request (host, IP, cookies), Auth.js's signIn and
// the outbound send replaced.

const BASE = 'r288.test'
const request = vi.hoisted(() => ({ host: 'localhost:3100', ip: '' }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: request.host, 'x-forwarded-for': request.ip }),
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}))
const signIn = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/auth.ts', () => ({
  auth: async () => null,
  signIn,
  signOut: async () => {},
  MfaRateLimited: class extends Error {},
}))
const deliverAuthLink = vi.hoisted(() => vi.fn(async (_: { recipient: { id: string } }) => {}))
vi.mock('./delivery.ts', () => ({ authUrl: (path: string) => path, deliverAuthLink }))

const { requestTenantMagicLink, requestGuarantorMagicLink, startStaffSignIn, requestPasswordReset } =
  await import('./actions.ts')
const { orgSlugFromHost, hostOrgId, principalIsStillValid } = await import('./org.ts')

const stamp = `r288-${randomUUID().slice(0, 8)}`
const email = `${stamp}@renter.test`
const staffEmail = `${stamp}@staff.test`
const PASSWORD = 'correct horse battery staple'
let orgB = ''
let tenant0 = ''
let tenantB = ''
let staffId = ''

const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}
const onHost = (host: string) => {
  request.host = host
  // A fresh IP per call: the point here is the org, not the rate limiter.
  request.ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
}
const sentTo = () => deliverAuthLink.mock.calls.map(([input]) => input.recipient.id)

beforeAll(async () => {
  vi.stubEnv('ORG_BASE_DOMAIN', BASE)
  orgB = (await prisma.organization.create({ data: { slug: stamp, name: `${stamp} B` } })).id
  tenant0 = (await prisma.tenant.create({ data: { orgId: 'org_0', firstName: 'Zero', lastName: stamp, email } })).id
  tenantB = (await prisma.tenant.create({ data: { orgId: orgB, firstName: 'Bee', lastName: stamp, email } })).id
  const staff = await prisma.staffUser.create({
    data: {
      email: staffEmail,
      name: stamp,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
      orgMemberships: { create: { orgId: 'org_0' } },
    },
  })
  staffId = staff.id
})

afterAll(async () => {
  await prisma.authToken.deleteMany({ where: { subjectId: { in: [tenant0, tenantB, staffId] } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenant0, tenantB] } } })
  await prisma.staffCredential.deleteMany({ where: { staffUserId: staffId } })
  await prisma.staffUser.deleteMany({ where: { id: staffId } })
  vi.unstubAllEnvs()
})

beforeEach(() => {
  deliverAuthLink.mockClear()
  signIn.mockClear()
})

describe('host → org', () => {
  it('reads a slug under the base, org #0 off it, and no org on the bare base or a nested name', () => {
    expect(orgSlugFromHost('acme.r288.test:3100', BASE)).toBe('acme')
    expect(orgSlugFromHost('ACME.R288.test', BASE)).toBe('acme')
    expect(orgSlugFromHost('localhost:3100', BASE)).toBeUndefined()
    expect(orgSlugFromHost('rent.labintelligence.co', BASE)).toBeUndefined()
    expect(orgSlugFromHost('r288.test', BASE)).toBeNull()
    expect(orgSlugFromHost('a.b.r288.test', BASE)).toBeNull()
    expect(orgSlugFromHost('evilr288.test', BASE)).toBeUndefined()
    // No base: every host is org #0, which is every environment today.
    expect(orgSlugFromHost('acme.r288.test', '')).toBeUndefined()
  })

  it('resolves an unknown slug to no org rather than to org #0', async () => {
    onHost(`nobody-${stamp}.${BASE}`)
    expect(await hostOrgId()).toBeNull()
    onHost(`${stamp}.${BASE}`)
    expect(await hostOrgId()).toBe(orgB)
  })
})

describe('tenant and guarantor magic links', () => {
  it('sends to the host org’s renter, never the other org’s row with the same email', async () => {
    onHost(`${stamp}.${BASE}`)
    await requestTenantMagicLink({}, form({ contact: email }))
    expect(sentTo()).toEqual([tenantB])

    deliverAuthLink.mockClear()
    onHost('localhost:3100')
    await requestTenantMagicLink({}, form({ contact: email }))
    expect(sentTo()).toEqual([tenant0])
  })

  it('sends nothing on a host that names no org, with the same neutral notice', async () => {
    onHost(BASE)
    const state = await requestTenantMagicLink({}, form({ contact: email }))
    expect(sentTo()).toEqual([])
    expect(state.notice).toMatch(/sign-in link is on its way/)
  })

  it('scopes the guarantor lookup the same way', async () => {
    onHost(`${stamp}.${BASE}`)
    await requestGuarantorMagicLink({}, form({ contact: email }))
    // Neither renter is a guarantor; what matters is that nothing went out.
    expect(sentTo()).toEqual([])
  })
})

describe('staff sign-in', () => {
  it('signs a member in on their own org’s host', async () => {
    onHost('localhost:3100')
    expect(await startStaffSignIn({}, form({ email: staffEmail, password: PASSWORD }))).toEqual({})
    expect(signIn).toHaveBeenCalledOnce()
  })

  it('answers a non-member exactly like a wrong password, and never counts it toward lockout', async () => {
    onHost(`${stamp}.${BASE}`)
    const right = await startStaffSignIn({}, form({ email: staffEmail, password: PASSWORD }))
    const wrong = await startStaffSignIn({}, form({ email: staffEmail, password: 'nope' }))
    expect(right).toEqual(wrong)
    expect(right.error).toMatch(/did not match an account/)
    expect(signIn).not.toHaveBeenCalled()
    const credential = await prisma.staffCredential.findUniqueOrThrow({ where: { staffUserId: staffId } })
    expect(credential.failedLoginCount).toBe(0)
  })

  it('mails a reset link only to a member of the host’s org', async () => {
    onHost(`${stamp}.${BASE}`)
    await requestPasswordReset({}, form({ email: staffEmail }))
    expect(sentTo()).toEqual([])
    onHost('localhost:3100')
    await requestPasswordReset({}, form({ email: staffEmail }))
    expect(sentTo()).toEqual([staffId])
  })
})

describe('every request re-proves the org', () => {
  const now = () => Date.now() + 1000

  it('keeps a staff session only on its org’s host and only while the membership is live', async () => {
    onHost('localhost:3100')
    expect(await principalIsStillValid(staffId, 'staff', now(), 'org_0')).toBe(true)
    expect(await principalIsStillValid(staffId, 'staff', now(), undefined)).toBe(false)
    expect(await principalIsStillValid(staffId, 'staff', now(), orgB)).toBe(false)

    onHost(`${stamp}.${BASE}`)
    expect(await principalIsStillValid(staffId, 'staff', now(), 'org_0')).toBe(false)

    onHost('localhost:3100')
    await prisma.orgMembership.update({
      where: { orgId_staffUserId: { orgId: 'org_0', staffUserId: staffId } },
      data: { removedAt: new Date() },
    })
    expect(await principalIsStillValid(staffId, 'staff', now(), 'org_0')).toBe(false)
  })

  it('keeps a renter’s session only in the org their row belongs to', async () => {
    onHost(`${stamp}.${BASE}`)
    expect(await principalIsStillValid(tenantB, 'tenant', now(), orgB)).toBe(true)
    expect(await principalIsStillValid(tenant0, 'tenant', now(), orgB)).toBe(false)
  })
})
