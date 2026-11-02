import 'server-only'

import { randomBytes } from 'node:crypto'
import { prisma } from '@rental/db'
import { isPlatformHost } from '@/lib/auth/platform-host.ts'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { DOMAIN, type DnsRecord } from './resend-provisioning.ts'
import { saveOrgIntegration } from './store.ts'

// A custom domain per org (R-276, PRD 10 §4): add the org's host to the one
// Vercel project every org is served from, show the DNS records Vercel asks
// for, poll verification with Vercel's reason verbatim, and only then write
// `Organization.customDomain`, the column `orgIdForHost` and `authUrl` read.
// Until that column is set the domain names no org, so a half-configured
// domain is a 404-shaped nothing rather than somebody else's sign-in page.
//
// SIMULATED (D-7), on the pattern of resend-provisioning.ts. `VercelDomains` is
// the seam a real driver replaces (POST /v10/projects/{id}/domains, then
// .../verify); the simulator keeps its OWN state in `SimulatedVercelDomain`
// (D-27). Unlike a simulated Resend row, a simulated verification DOES write
// the column: nothing is sent from a host, it is only answered on, and the
// e2e suite needs a verified domain to sign in on. That is why the simulator
// refuses to start at all on a Vercel deployment (D-382).
//
// Row status: PROVISIONING until Vercel verifies, then VERIFIED, FAILED with
// Vercel's reason, or RETIRED. Cookies need nothing: every session cookie is
// host-only (no `Domain` attribute), so a custom domain gets its own session
// and a slug host's cookie never reaches it.

export type DomainState = { verified: boolean; reason: string | null }

export interface VercelDomains {
  readonly name: string
  /// Adds the domain to the project. Refuses one already on it.
  addDomain(name: string): Promise<{ records: DnsRecord[] }>
  /// Asks Vercel to check the records now.
  verify(name: string): Promise<DomainState>
  removeDomain(name: string): Promise<void>
}

class SimulatedVercelDomains implements VercelDomains {
  readonly name = 'simulated'

  async addDomain(name: string) {
    const verification: DnsRecord = {
      type: 'TXT',
      name: `_vercel.${name}`,
      value: `vc-domain-verify=${name},${randomBytes(10).toString('hex')}`,
    }
    try {
      await prisma.simulatedVercelDomain.create({ data: { name, verification } })
    } catch (error) {
      // Vercel's own sentence for a domain already on the project.
      if (isUniqueViolation(error)) throw new Error(`The domain "${name}" is already in use by one of your projects.`)
      throw error
    }
    console.info(`[vercel:simulated] domain ${name}`)
    return { records: [{ type: 'CNAME', name, value: 'cname.vercel-dns.com' }, verification] }
  }

  /// One step per call: unverified becomes verified, or stays unverified with the seam's reason.
  async verify(name: string) {
    const domain = await prisma.simulatedVercelDomain.findUnique({ where: { name } })
    if (!domain) throw new Error(`The domain "${name}" is not on this project.`)
    const state: DomainState = domain.failWith
      ? { verified: false, reason: domain.failWith }
      : { verified: true, reason: null }
    await prisma.simulatedVercelDomain.update({ where: { name }, data: { verified: state.verified, reason: state.reason } })
    return state
  }

  async removeDomain(name: string) {
    await prisma.simulatedVercelDomain.deleteMany({ where: { name } })
  }
}

export const vercelDomains: VercelDomains = new SimulatedVercelDomains()

/// The row as the console reads it. Config values are strings.
export type DomainRow = { id: string; status: string; statusReason: string | null; config: Record<string, string> }

function strings(config: unknown): Record<string, string> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  return Object.fromEntries(
    Object.entries(config as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
  )
}

export async function domainRow(orgId: string): Promise<DomainRow | null> {
  const row = await prisma.orgIntegration.findUnique({
    where: { orgId_provider: { orgId, provider: 'VERCEL' } },
    select: { id: true, status: true, statusReason: true, config: true },
  })
  return row ? { id: row.id, status: row.status, statusReason: row.statusReason, config: strings(row.config) } : null
}

const hostname = (url: string | undefined) => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/// Why `name` can never be an org's own host, or null. These hosts already
/// mean something (org #0, the console, a slug), and `orgIdForHost` would
/// answer for them before it ever read the column.
export function reservedDomain(name: string): string | null {
  const base = process.env.ORG_BASE_DOMAIN?.trim().toLowerCase()
  if (base && (name === base || name.endsWith(`.${base}`))) return `Hosts under ${base} are organisation subdomains already.`
  if (isPlatformHost(name)) return 'That is the platform console’s host.'
  if (name === hostname(process.env.AUTH_URL)) return 'That is the default organisation’s host.'
  return null
}

/**
 * Adds the org's domain. Refused while a row is PROVISIONING or VERIFIED; a
 * NOT_STARTED, FAILED or RETIRED row starts again. The claim is a conditional
 * write, so two admins pressing at once start one.
 */
export async function startDomainProvisioning(
  orgId: string,
  domain: string,
): Promise<{ ok: true; row: DomainRow } | { ok: false; error: string }> {
  const name = domain.trim().toLowerCase()
  if (!DOMAIN.test(name)) return { ok: false, error: 'A custom domain is a hostname such as portal.example.com.' }
  const reserved = reservedDomain(name)
  if (reserved) return { ok: false, error: reserved }
  // A simulated verification goes live (see the header), so on a real
  // deployment it would move every emailed link onto a host no DNS points at.
  // Vercel sets VERCEL=1 at runtime on every deployment it serves, production
  // and previews alike, and never on a laptop or in CI.
  if (vercelDomains.name === 'simulated' && process.env.VERCEL === '1') {
    return { ok: false, error: 'Custom domains need the real Vercel driver, which this deployment does not have yet.' }
  }
  const previous = await domainRow(orgId)
  const claimed = previous
    ? (
        await prisma.orgIntegration.updateMany({
          where: { orgId, provider: 'VERCEL', status: { in: ['NOT_STARTED', 'FAILED', 'RETIRED'] } },
          data: { status: 'PROVISIONING', statusReason: null },
        })
      ).count === 1
    : await prisma.orgIntegration
        .create({ data: { orgId, provider: 'VERCEL', status: 'PROVISIONING' } })
        .then(() => true, (error: unknown) => (isUniqueViolation(error) ? false : Promise.reject(error)))
  if (!claimed) return { ok: false, error: 'A custom domain is already being set up for this organisation.' }

  try {
    if (previous?.status === 'FAILED' && previous.config.domain) await vercelDomains.removeDomain(previous.config.domain)
    const { records } = await vercelDomains.addDomain(name)
    const now = new Date().toISOString()
    await saveOrgIntegration(orgId, 'VERCEL', {
      status: 'PROVISIONING',
      statusReason: null,
      config: { provisionedBy: vercelDomains.name, domain: name, dnsRecords: JSON.stringify(records), startedAt: now, polledAt: now },
    })
    return { ok: true, row: (await domainRow(orgId))! }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Provisioning stopped unexpectedly.'
    await saveOrgIntegration(orgId, 'VERCEL', { status: 'FAILED', statusReason: reason })
    return { ok: false, error: reason }
  }
}

/**
 * Asks Vercel to verify and records the answer (on demand and nightly). Only a
 * PROVISIONING row is polled, and an unverified answer leaves it PROVISIONING
 * with Vercel's reason: DNS takes time, so "not yet" is not a failure. On
 * verification the row and `Organization.customDomain` change together.
 */
export async function pollDomainProvisioning(
  orgId: string,
): Promise<{ before: DomainRow; after: DomainRow } | null> {
  const before = await domainRow(orgId)
  const domain = before?.config.domain
  // ponytail: a verified domain whose DNS later moves away is not re-checked;
  // poll VERIFIED rows too once a real driver exists.
  if (!before || before.status !== 'PROVISIONING' || !domain) return null

  const state = await vercelDomains.verify(domain)
  const status = state.verified ? 'VERIFIED' : 'PROVISIONING'
  const config: Record<string, string> = { ...before.config, polledAt: new Date().toISOString() }
  if (state.verified) config.verifiedAt = config.polledAt
  const changed = await prisma.$transaction(async (tx) => {
    // Conditional on PROVISIONING, so a retire pressed meanwhile is not undone.
    const { count } = await tx.orgIntegration.updateMany({
      where: { orgId, provider: 'VERCEL', status: 'PROVISIONING' },
      data: { status, statusReason: state.reason, config },
    })
    if (count === 1 && state.verified) await tx.organization.update({ where: { id: orgId }, data: { customDomain: domain } })
    return count === 1
  })
  return changed ? { before, after: { id: before.id, status, statusReason: state.reason, config } } : null
}

/// Removes the domain and keeps the row as RETIRED. The column is cleared in
/// the same transaction, so the host stops naming the org and every link is
/// built on the org's subdomain again.
export async function retireDomainProvisioning(orgId: string): Promise<{ before: DomainRow } | null> {
  const before = await domainRow(orgId)
  if (!before || before.status === 'RETIRED') return null
  if (before.config.domain) await vercelDomains.removeDomain(before.config.domain)
  await prisma.$transaction([
    prisma.organization.update({ where: { id: orgId }, data: { customDomain: null } }),
    prisma.orgIntegration.update({
      where: { orgId_provider: { orgId, provider: 'VERCEL' } },
      data: { status: 'RETIRED', statusReason: null, config: { ...before.config, retiredAt: new Date().toISOString() } },
    }),
  ])
  return { before }
}
