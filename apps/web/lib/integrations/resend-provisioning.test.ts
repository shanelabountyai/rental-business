import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, describe, expect, it } from 'vitest'
import { inboundEmailConfig, inboundEmailSecret } from '@/lib/comms/inbound-email-config.ts'
import { orgIntegration, resendSecrets } from './store.ts'
import {
  dnsRecords,
  pollResendProvisioning,
  resendRow,
  retireResendProvisioning,
  startResendProvisioning,
} from './resend-provisioning.ts'

// R-293b (PRD 10 §4). Provisioning runs against the simulated provisioner,
// whose own state (`SimulatedResendDomain`, D-27) is what a poll reads. No
// action is called: an AuditLog row in the org is append-only and would stop
// the org being cleaned up. Every domain name carries the stamp, so cleanup is
// by ownership.

const stamp = `r293b-${randomUUID().slice(0, 8)}`
const DOMAIN = `mail.${stamp}.example.test`
const orgIds: string[] = []

async function seedOrg(suffix: string): Promise<string> {
  const org = await prisma.organization.create({ data: { slug: `${stamp}-${suffix}`, name: `Org ${stamp} ${suffix}` } })
  orgIds.push(org.id)
  return org.id
}

afterAll(async () => {
  await prisma.simulatedResendDomain.deleteMany({ where: { name: { contains: stamp } } })
  await prisma.orgIntegration.deleteMany({ where: { orgId: { in: orgIds } } })
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
})

describe('Resend domain provisioning, simulated (R-293b)', () => {
  let orgA = ''

  it('adds the domain with its DNS records, mints the sealed key and inbound secret, and sends from nothing new yet', async () => {
    orgA = await seedOrg('a')
    expect(await startResendProvisioning(orgA, 'not a domain')).toMatchObject({ ok: false })
    const started = await startResendProvisioning(orgA, ` ${DOMAIN.toUpperCase()} `)
    expect(started.ok).toBe(true)
    const row = (await resendRow(orgA))!
    expect(row).toMatchObject({ status: 'PROVISIONING', statusReason: null })
    expect(row.config).toMatchObject({ provisionedBy: 'simulated', domain: DOMAIN, domainStatus: 'PENDING' })
    // Before verification Resend refuses the `from` and no MX delivers to the address.
    expect(row.config.from).toBeUndefined()
    expect(row.config.inboundAddress).toBeUndefined()
    expect(dnsRecords(row).map((r) => `${r.type} ${r.name}`)).toEqual([
      `MX send.${DOMAIN}`,
      `TXT send.${DOMAIN}`,
      `TXT resend._domainkey.${DOMAIN}`,
      `MX ${DOMAIN}`,
    ])
    const sealed = (await orgIntegration(orgA, 'RESEND'))!.secret!
    const { apiKey, inboundSecret } = resendSecrets(sealed)
    expect(apiKey).toMatch(/^re_[0-9a-f]{32}$/)
    expect(inboundSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row.config)).not.toContain(apiKey!)
    expect(JSON.stringify(row.config)).not.toContain(inboundSecret!)
    // The org's inbound webhook now answers to its own secret.
    expect(await inboundEmailSecret(orgA)).toBe(inboundSecret)
    expect(await startResendProvisioning(orgA, DOMAIN)).toMatchObject({ ok: false })
  })

  it("refuses a domain another org holds, with Resend's words on the second org's row", async () => {
    const orgB = await seedOrg('b')
    const refused = await startResendProvisioning(orgB, DOMAIN)
    const reason = `The domain ${DOMAIN} has been registered already.`
    expect(refused).toEqual({ ok: false, error: reason })
    expect(await resendRow(orgB)).toMatchObject({ status: 'FAILED', statusReason: reason })
  })

  it('reads our row, not the simulator: a verification nobody polled for changes nothing (D-27)', async () => {
    const { domainId } = (await resendRow(orgA))!.config
    await prisma.simulatedResendDomain.update({ where: { domainId: domainId! }, data: { status: 'VERIFIED' } })
    expect((await resendRow(orgA))!.config).toMatchObject({ domainStatus: 'PENDING' })
    await prisma.simulatedResendDomain.update({ where: { domainId: domainId! }, data: { status: 'PENDING' } })
  })

  it('verifies on a poll, gaining its from and inbound address, then stops polling', async () => {
    const poll = await pollResendProvisioning(orgA)
    expect(poll!.after).toMatchObject({ status: 'VERIFIED', statusReason: null })
    const row = (await resendRow(orgA))!
    expect(row.config).toMatchObject({
      domainStatus: 'VERIFIED',
      from: `notifications@${DOMAIN}`,
      inboundAddress: `reply@${DOMAIN}`,
    })
    expect(await pollResendProvisioning(orgA)).toBeNull()
    // A simulated domain has no MX anywhere: its address is no Reply-To.
    expect(await inboundEmailConfig(orgA)).toBeNull()
  })

  it('retires: the domain is removed, the row keeps no key, no from and no inbound address', async () => {
    const before = (await resendRow(orgA))!
    expect(await retireResendProvisioning(orgA)).not.toBeNull()
    const row = (await resendRow(orgA))!
    expect(row.status).toBe('RETIRED')
    expect(row.config.from).toBeUndefined()
    expect(row.config.inboundAddress).toBeUndefined()
    expect((await orgIntegration(orgA, 'RESEND'))!.secret).toBeNull()
    expect(await inboundEmailSecret(orgA)).toBeNull()
    const sim = await prisma.simulatedResendDomain.findUniqueOrThrow({ where: { domainId: before.config.domainId! } })
    expect(sim.closedAt).not.toBeNull()
    expect(await retireResendProvisioning(orgA)).toBeNull()
  })

  it("shows Resend's failure reason verbatim, and a failed org may start again on a freed domain", async () => {
    const orgC = await seedOrg('c')
    // orgA retired the domain, so it is free to add again.
    expect((await startResendProvisioning(orgC, DOMAIN)).ok).toBe(true)
    const reason = `The DKIM record resend._domainkey.${DOMAIN} was not found (${stamp})`
    const { domainId } = (await resendRow(orgC))!.config
    await prisma.simulatedResendDomain.update({ where: { domainId: domainId! }, data: { failWith: reason } })
    await pollResendProvisioning(orgC)
    const row = (await resendRow(orgC))!
    expect(row).toMatchObject({ status: 'FAILED', statusReason: reason })
    expect(row.config).toMatchObject({ domainStatus: 'FAILED', domainReason: reason })
    expect(await pollResendProvisioning(orgC)).toBeNull()
    // Starting again removes the failed domain first, so the same name is not "registered already".
    expect((await startResendProvisioning(orgC, DOMAIN)).ok).toBe(true)
    expect((await resendRow(orgC))!.config.domainId).not.toBe(domainId)
  })

  it('leaves org #0, which has no row, on the env inbound secret (D-362)', async () => {
    expect(await prisma.orgIntegration.findFirst({ where: { orgId: 'org_0', provider: 'RESEND' } })).toBeNull()
    expect(await inboundEmailSecret('org_0')).toBe(process.env.INBOUND_EMAIL_SECRET?.trim() || null)
  })
})
