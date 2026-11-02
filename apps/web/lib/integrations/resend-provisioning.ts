import 'server-only'

import { randomBytes, randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { saveOrgIntegration } from './store.ts'

// Per-org Resend domain provisioning (R-293b, PRD 10 §4): add the org's
// sending domain, show the DNS records Resend asks for, poll verification
// with Resend's reason verbatim, and keep the domain-scoped key and the
// inbound secret sealed on the RESEND row R-293a already sends and receives
// on.
//
// SIMULATED (D-7), on the pattern of twilio-provisioning.ts. `ResendProvisioner`
// is the seam a real driver replaces; the simulator keeps its OWN state in
// `SimulatedResendDomain` (D-27) and answers polls from that, never from our
// `OrgIntegration.config`. A row it provisioned carries
// `provisionedBy: 'simulated'`: the live adapter never sends from its domain
// (`ownDomainSender`) and its inbound address is no Reply-To
// (`inboundEmailConfig`), because no DNS anywhere points at it.
//
// Row status: PROVISIONING until Resend verifies, then VERIFIED (PRD 10 §5
// step 7 reads exactly that), FAILED with Resend's reason, or RETIRED. The
// send gate itself is `config.domainStatus`, which R-293a reads.

export type DnsRecord = { type: string; name: string; value: string; priority?: number }
export type DomainState = { status: DomainStatus; reason: string | null }
type DomainStatus = 'PENDING' | 'VERIFIED' | 'FAILED'

export interface ResendProvisioner {
  readonly name: string
  /// Adds the domain and starts verification. Refuses a domain another
  /// account (here: another org) already holds open.
  addDomain(name: string): Promise<{ domainId: string; records: DnsRecord[] }>
  /// An API key that can send only from `domainId`.
  createDomainKey(domainId: string): Promise<string>
  poll(domainId: string): Promise<DomainState>
  removeDomain(domainId: string): Promise<void>
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex')

class SimulatedResendProvisioner implements ResendProvisioner {
  readonly name = 'simulated'

  async addDomain(name: string) {
    const taken = await prisma.simulatedResendDomain.findFirst({ where: { name, closedAt: null } })
    // Resend's own sentence for a domain registered elsewhere.
    if (taken) throw new Error(`The domain ${name} has been registered already.`)
    const domainId = randomUUID()
    const records: DnsRecord[] = [
      { type: 'MX', name: `send.${name}`, value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
      { type: 'TXT', name: `send.${name}`, value: 'v=spf1 include:amazonses.com ~all' },
      { type: 'TXT', name: `resend._domainkey.${name}`, value: `p=${randomBytes(48).toString('base64')}` },
      // Receiving: replies to the inbound address land at Resend.
      { type: 'MX', name, value: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 },
    ]
    await prisma.simulatedResendDomain.create({ data: { domainId, name, status: 'PENDING', records } })
    console.info(`[resend:simulated] domain ${domainId} for ${name}`)
    return { domainId, records }
  }

  async createDomainKey() {
    return `re_${hex(16)}`
  }

  /// One step per poll: PENDING becomes VERIFIED, or FAILED with the seam's reason.
  async poll(domainId: string) {
    const domain = await prisma.simulatedResendDomain.findUnique({ where: { domainId } })
    if (!domain || domain.closedAt) throw new Error(`Resend has no domain ${domainId}.`)
    let state: DomainState = { status: domain.status as DomainStatus, reason: domain.reason }
    if (state.status === 'PENDING') {
      state = domain.failWith ? { status: 'FAILED', reason: domain.failWith } : { status: 'VERIFIED', reason: null }
      await prisma.simulatedResendDomain.update({ where: { domainId }, data: { status: state.status, reason: state.reason } })
    }
    return state
  }

  async removeDomain(domainId: string) {
    await prisma.simulatedResendDomain.updateMany({ where: { domainId, closedAt: null }, data: { closedAt: new Date() } })
  }
}

export const resendProvisioner: ResendProvisioner = new SimulatedResendProvisioner()

/// A hostname of two or more labels, lower case. The org's own subdomain, e.g. mail.example.com.
export const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/// The row as the console reads it. Config values are strings.
export type ResendRow = { id: string; status: string; statusReason: string | null; config: Record<string, string> }

function strings(config: unknown): Record<string, string> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  return Object.fromEntries(
    Object.entries(config as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
  )
}

export async function resendRow(orgId: string): Promise<ResendRow | null> {
  const row = await prisma.orgIntegration.findUnique({
    where: { orgId_provider: { orgId, provider: 'RESEND' } },
    select: { id: true, status: true, statusReason: true, config: true },
  })
  return row ? { id: row.id, status: row.status, statusReason: row.statusReason, config: strings(row.config) } : null
}

/// The DNS records the row was given, for the panel. Empty when unreadable.
export function dnsRecords(row: ResendRow | null): DnsRecord[] {
  try {
    const value = JSON.parse(row?.config.dnsRecords ?? '[]') as unknown
    return Array.isArray(value) ? (value as DnsRecord[]) : []
  } catch {
    return []
  }
}

/**
 * Adds the org's domain. Refused while a row is PROVISIONING or VERIFIED; a
 * NOT_STARTED, FAILED or RETIRED row starts again on a new domain id. The
 * claim is a conditional write, so two admins pressing at once start one.
 * Mints the domain-scoped key and a new inbound secret now, so verification
 * changes one status and nothing else.
 */
export async function startResendProvisioning(
  orgId: string,
  domain: string,
): Promise<{ ok: true; row: ResendRow } | { ok: false; error: string }> {
  const name = domain.trim().toLowerCase()
  if (!DOMAIN.test(name)) return { ok: false, error: 'A sending domain is a hostname such as mail.example.com.' }
  const previous = await resendRow(orgId)
  const claimed = previous
    ? (
        await prisma.orgIntegration.updateMany({
          where: { orgId, provider: 'RESEND', status: { in: ['NOT_STARTED', 'FAILED', 'RETIRED'] } },
          data: { status: 'PROVISIONING', statusReason: null },
        })
      ).count === 1
    : await prisma.orgIntegration
        .create({ data: { orgId, provider: 'RESEND', status: 'PROVISIONING' } })
        .then(() => true, (error: unknown) => (isUniqueViolation(error) ? false : Promise.reject(error)))
  if (!claimed) return { ok: false, error: 'Email domain provisioning has already started for this organisation.' }

  try {
    if (previous?.status === 'FAILED' && previous.config.domainId) {
      await resendProvisioner.removeDomain(previous.config.domainId)
    }
    const { domainId, records } = await resendProvisioner.addDomain(name)
    const apiKey = await resendProvisioner.createDomainKey(domainId)
    const now = new Date().toISOString()
    // No `from` or `inboundAddress` until VERIFIED: before then Resend refuses
    // the `from`, and no MX delivers to the address.
    const config: Record<string, string> = {
      provisionedBy: resendProvisioner.name,
      domain: name,
      domainId,
      domainStatus: 'PENDING',
      dnsRecords: JSON.stringify(records),
      startedAt: now,
      polledAt: now,
    }
    await saveOrgIntegration(orgId, 'RESEND', {
      status: 'PROVISIONING',
      statusReason: null,
      config,
      secret: JSON.stringify({ apiKey, inboundSecret: hex(32) }),
    })
    return { ok: true, row: (await resendRow(orgId))! }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Provisioning stopped unexpectedly.'
    await saveOrgIntegration(orgId, 'RESEND', { status: 'FAILED', statusReason: reason })
    return { ok: false, error: reason }
  }
}

/**
 * Asks Resend whether the domain verified and records the answer (on demand
 * and nightly). Only a PROVISIONING row is polled. On VERIFIED the row gains
 * its `from` and `inboundAddress`, which is the moment R-293a starts sending
 * from the domain.
 */
export async function pollResendProvisioning(
  orgId: string,
): Promise<{ before: ResendRow; after: ResendRow } | null> {
  const before = await resendRow(orgId)
  const domainId = before?.config.domainId
  // ponytail: a VERIFIED domain whose DNS later vanishes (Resend's
  // temporary_failure) is not watched; poll VERIFIED rows nightly too once a
  // real driver exists.
  if (!before || before.status !== 'PROVISIONING' || !domainId) return null

  const state = await resendProvisioner.poll(domainId)
  const config: Record<string, string> = {
    ...before.config,
    domainStatus: state.status,
    polledAt: new Date().toISOString(),
  }
  if (state.reason) config.domainReason = state.reason
  else delete config.domainReason
  if (state.status === 'VERIFIED') {
    config.from = `notifications@${before.config.domain}`
    config.inboundAddress = `reply@${before.config.domain}`
  }
  const status = state.status === 'PENDING' ? 'PROVISIONING' : state.status
  const statusReason = state.status === 'FAILED' ? state.reason : null
  // Conditional on PROVISIONING, so a retire pressed meanwhile is not undone.
  const { count } = await prisma.orgIntegration.updateMany({
    where: { orgId, provider: 'RESEND', status: 'PROVISIONING' },
    data: { status, statusReason, config },
  })
  return count === 1 ? { before, after: { id: before.id, status, statusReason, config } } : null
}

/// Removes the domain and keeps the row as RETIRED: no `from`, no inbound
/// address, no secret. The org falls back to the shared sender (D-376), and
/// its inbound webhook refuses every post.
export async function retireResendProvisioning(orgId: string): Promise<{ before: ResendRow } | null> {
  const before = await resendRow(orgId)
  if (!before || before.status === 'RETIRED') return null
  if (before.config.domainId) await resendProvisioner.removeDomain(before.config.domainId)
  const { from: _from, inboundAddress: _inbound, ...config } = before.config
  await saveOrgIntegration(orgId, 'RESEND', {
    status: 'RETIRED',
    statusReason: null,
    config: { ...config, retiredAt: new Date().toISOString() },
    secret: null,
  })
  return { before }
}
