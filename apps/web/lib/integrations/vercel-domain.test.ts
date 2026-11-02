import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_ORG_ID, orgIdForHost } from '@/lib/auth/org.ts'
import { authUrl, signedWebhookUrl } from '@/lib/auth/org-url.ts'
import { relativeRedirect } from '@/lib/auth/redirect.ts'
import {
  domainRow,
  pollDomainProvisioning,
  reservedDomain,
  retireDomainProvisioning,
  startDomainProvisioning,
} from './vercel-domain.ts'

// R-276 (PRD 10 §4). Runs against the simulated Vercel, whose own state
// (`SimulatedVercelDomain`, D-27) is what a poll reads. No action is called,
// for the reason resend-provisioning.test.ts gives. Every name carries the
// stamp, so cleanup is by ownership.

const stamp = `r276-${randomUUID().slice(0, 8)}`
const DOMAIN = `portal.${stamp}.example.test`
const orgIds: string[] = []
const env = { AUTH_URL: process.env.AUTH_URL, ORG_BASE_DOMAIN: process.env.ORG_BASE_DOMAIN, PLATFORM_HOST: process.env.PLATFORM_HOST }

async function seedOrg(suffix: string): Promise<string> {
  const org = await prisma.organization.create({ data: { slug: `${stamp}-${suffix}`, name: `Org ${stamp} ${suffix}` } })
  orgIds.push(org.id)
  return org.id
}

beforeAll(() => {
  process.env.AUTH_URL = 'http://localhost:3100'
  process.env.ORG_BASE_DOMAIN = 'orgs.localhost'
  process.env.PLATFORM_HOST = 'platform.localhost'
})

afterAll(async () => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await prisma.simulatedVercelDomain.deleteMany({ where: { name: { contains: stamp } } })
  await prisma.organization.updateMany({ where: { id: { in: orgIds } }, data: { customDomain: null } })
  await prisma.orgIntegration.deleteMany({ where: { orgId: { in: orgIds } } })
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
})

describe('custom domain provisioning, simulated (R-276)', () => {
  let orgA = ''

  it('adds the domain with its records, and the host names nobody until Vercel verifies it', async () => {
    orgA = await seedOrg('a')
    const started = await startDomainProvisioning(orgA, ` ${DOMAIN.toUpperCase()} `)
    expect(started.ok).toBe(true)
    const row = (await domainRow(orgA))!
    expect(row.status).toBe('PROVISIONING')
    expect(row.config.domain).toBe(DOMAIN)
    expect(JSON.parse(row.config.dnsRecords).map((r: { type: string }) => r.type)).toEqual(['CNAME', 'TXT'])
    // Unverified: still org #0's fallback, and links still on the subdomain.
    expect(await orgIdForHost(`${DOMAIN}:3100`)).toBe(DEFAULT_ORG_ID)
    expect(await authUrl(orgA, '/login')).toBe(`http://${stamp}-a.orgs.localhost:3100/login`)
  })

  it('refuses a second start, and the same domain for another org with Vercel’s sentence', async () => {
    expect(await startDomainProvisioning(orgA, `other.${stamp}.example.test`)).toEqual({
      ok: false,
      error: 'A custom domain is already being set up for this organisation.',
    })
    const orgB = await seedOrg('b')
    const refused = await startDomainProvisioning(orgB, DOMAIN)
    expect(refused).toEqual({ ok: false, error: `The domain "${DOMAIN}" is already in use by one of your projects.` })
    expect((await domainRow(orgB))!.status).toBe('FAILED')
  })

  it('on verification the host names the org and every link is built on it', async () => {
    const polled = await pollDomainProvisioning(orgA)
    expect(polled?.after.status).toBe('VERIFIED')
    expect(await orgIdForHost(`${DOMAIN}:3100`)).toBe(orgA)
    expect(await authUrl(orgA, '/vendor/abc')).toBe(`http://${DOMAIN}:3100/vendor/abc`)
    // The URL Twilio signed is the one we registered, whatever host it arrived on.
    const request = new Request('http://10.0.0.7:3000/api/sms/status?x=1', { method: 'POST' })
    expect(await signedWebhookUrl(request, orgA)).toBe(`http://${DOMAIN}:3100/api/sms/status?x=1`)
    // The slug host still names the org: both hosts are its, with separate cookies.
    expect(await orgIdForHost(`${stamp}-a.orgs.localhost:3100`)).toBe(orgA)
    expect(await pollDomainProvisioning(orgA)).toBeNull()
  })

  it('an unverified answer stays PROVISIONING with Vercel’s reason verbatim', async () => {
    const orgC = await seedOrg('c')
    const name = `c.${stamp}.example.test`
    await startDomainProvisioning(orgC, name)
    await prisma.simulatedVercelDomain.update({ where: { name }, data: { failWith: 'TXT record not found.' } })
    const polled = await pollDomainProvisioning(orgC)
    expect(polled?.after).toMatchObject({ status: 'PROVISIONING', statusReason: 'TXT record not found.' })
    expect(await orgIdForHost(name)).toBe(DEFAULT_ORG_ID)
  })

  it('retiring clears the host in the same step and links go back to the subdomain', async () => {
    expect(await retireDomainProvisioning(orgA)).not.toBeNull()
    expect((await domainRow(orgA))!.status).toBe('RETIRED')
    expect(await orgIdForHost(DOMAIN)).toBe(DEFAULT_ORG_ID)
    expect(await authUrl(orgA, '/login')).toBe(`http://${stamp}-a.orgs.localhost:3100/login`)
    expect(await prisma.simulatedVercelDomain.count({ where: { name: DOMAIN } })).toBe(0)
    // And it can start again on the same name.
    expect((await startDomainProvisioning(orgA, DOMAIN)).ok).toBe(true)
  })

  it('refuses to start on a Vercel deployment, where a simulated verification would move live links', async () => {
    const orgD = await seedOrg('d')
    process.env.VERCEL = '1'
    try {
      expect(await startDomainProvisioning(orgD, `d.${stamp}.example.test`)).toEqual({
        ok: false,
        error: 'Custom domains need the real Vercel driver, which this deployment does not have yet.',
      })
    } finally {
      delete process.env.VERCEL
    }
    expect(await domainRow(orgD)).toBeNull()
  })

  it('refuses hosts that already mean something', () => {
    expect(reservedDomain('acme.orgs.localhost')).toMatch(/subdomains already/)
    expect(reservedDomain('orgs.localhost')).toMatch(/subdomains already/)
    expect(reservedDomain('platform.localhost')).toMatch(/console/)
    expect(reservedDomain('localhost')).toMatch(/default organisation/)
    expect(reservedDomain(DOMAIN)).toBeNull()
  })

  it('the database refuses a custom domain that is not a lower-case bare hostname', async () => {
    await expect(
      prisma.organization.update({ where: { id: orgIds[1] }, data: { customDomain: 'Portal.Example.com' } }),
    ).rejects.toThrow(/Organization_customDomain_host/)
  })
})

describe('relativeRedirect (R-276, D-379)', () => {
  const base = 'http://localhost:3100'
  it('keeps a relative path relative, so the browser stays on its own host', () => {
    expect(relativeRedirect('/dashboard', base)).toBe('/dashboard')
  })
  it('strips a same-origin absolute URL to its path', () => {
    expect(relativeRedirect('http://localhost:3100/login?reset=1', base)).toBe('/login?reset=1')
  })
  it('never sends the browser off-site', () => {
    expect(relativeRedirect('https://evil.example/x', base)).toBe('/')
    expect(relativeRedirect('//evil.example/x', base)).toBe('/')
    expect(relativeRedirect('not a url', base)).toBe('/')
  })
})
