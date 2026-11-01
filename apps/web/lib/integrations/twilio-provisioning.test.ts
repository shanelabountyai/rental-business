import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deliverOverChannel } from '@/lib/notifications/deliver.ts'
import { orgIntegration } from './store.ts'
import {
  pollTwilioProvisioning,
  retireTwilioProvisioning,
  smsSendRefusal,
  startTwilioProvisioning,
  twilioRow,
} from './twilio-provisioning.ts'

// R-292b (PRD 10 §3.1). Provisioning runs against the simulated provisioner,
// whose own state (`SimulatedTwilioAccount`, D-27) is what a poll reads. The
// send gate is proven through `deliverOverChannel`, the one function every
// send passes through, so what is asserted is the delivery outcome a row
// records. No action is called: an AuditLog row in the org is append-only and
// would stop the org being cleaned up.

const stamp = `r292b-${randomUUID().slice(0, 8)}`
const random7 = () => String(Math.floor(Math.random() * 9_000_000) + 1_000_000)
const OWNER_PHONE = `+1737${random7()}`
const STRANGER = `+1555${random7()}`
const orgIds: string[] = []
const staffIds: string[] = []

async function seedOrg(suffix: string): Promise<string> {
  const org = await prisma.organization.create({ data: { slug: `${stamp}-${suffix}`, name: `Org ${stamp} ${suffix}` } })
  orgIds.push(org.id)
  return org.id
}

const sms = (orgId: string, to: string) => deliverOverChannel({ channel: 'SMS', to, body: `hello ${stamp}`, orgId })

let orgA = ''

beforeAll(async () => {
  orgA = await seedOrg('a')
  const owner = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  const staff = await prisma.staffUser.create({
    data: {
      orgMemberships: { create: { orgId: orgA } },
      email: `${stamp}@example.test`,
      name: 'Owner Phone',
      // Formatted, not E.164: the gate normalises both sides.
      phone: `(737) ${OWNER_PHONE.slice(5, 8)}-${OWNER_PHONE.slice(8)}`,
    },
  })
  staffIds.push(staff.id)
  await prisma.staffAssignment.create({ data: { orgId: orgA, staffUserId: staff.id, roleId: owner.id } })
})

afterAll(async () => {
  const sids = await prisma.orgIntegration.findMany({ where: { orgId: { in: orgIds } }, select: { config: true } })
  const accountSids = sids.map((r) => (r.config as Record<string, string>).accountSid).filter(Boolean)
  await prisma.simulatedTwilioAccount.deleteMany({ where: { accountSid: { in: accountSids } } })
  await prisma.orgIntegration.deleteMany({ where: { orgId: { in: orgIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.orgMembership.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.deleteMany({ where: { id: { in: staffIds } } })
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
})

describe('Twilio provisioning, simulated (R-292b)', () => {
  it('starts with a subaccount, a number in the area code, a service and a pending brand', async () => {
    const started = await startTwilioProvisioning(orgA, '737')
    expect(started.ok).toBe(true)
    const row = await twilioRow(orgA)
    expect(row).toMatchObject({ status: 'PROVISIONING', statusReason: null })
    expect(row!.config).toMatchObject({ provisionedBy: 'simulated', brandStatus: 'PENDING' })
    expect(row!.config.accountSid).toMatch(/^AC[0-9a-f]{32}$/)
    expect(row!.config.messagingServiceSid).toMatch(/^MG[0-9a-f]{32}$/)
    expect(row!.config.phoneNumber).toMatch(/^\+1737[2-9]\d{6}$/)
    // PRD 10 §3.3: the opt-in names the org, which has no business name set.
    expect(row!.config.optInDescription).toContain(`from Org ${stamp} a at this number`)
    // The subaccount token is sealed, never in config.
    expect((await orgIntegration(orgA, 'TWILIO'))!.secret).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(row!.config)).not.toContain((await orgIntegration(orgA, 'TWILIO'))!.secret!)
    expect(await startTwilioProvisioning(orgA, '737')).toMatchObject({ ok: false })
  })

  it('texts only the owner while the campaign is in review', async () => {
    expect(await sms(orgA, STRANGER)).toEqual({ status: 'SUPPRESSED', suppressedReason: 'campaign_not_approved' })
    expect((await sms(orgA, OWNER_PHONE)).status).toBe('SENT')
  })

  it('reads our row, not the simulator: an approval nobody polled for does not open the gate (D-27)', async () => {
    const { accountSid } = (await twilioRow(orgA))!.config
    await prisma.simulatedTwilioAccount.update({
      where: { accountSid: accountSid! },
      data: { brandStatus: 'APPROVED', campaignStatus: 'APPROVED' },
    })
    expect(await smsSendRefusal(orgA, STRANGER)).toBe('campaign_not_approved')
    // Put the simulator back where its own reviews stood.
    await prisma.simulatedTwilioAccount.update({
      where: { accountSid: accountSid! },
      data: { brandStatus: 'PENDING', campaignStatus: null },
    })
  })

  it('advances one review step per poll, registers the campaign on the brand approval, then goes ACTIVE', async () => {
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      const poll = await pollTwilioProvisioning(orgA)
      seen.push(`${poll!.after.config.brandStatus}/${poll!.after.config.campaignStatus ?? '-'}`)
    }
    expect(seen).toEqual(['IN_REVIEW/-', 'APPROVED/PENDING', 'APPROVED/IN_REVIEW', 'APPROVED/APPROVED'])
    const row = await twilioRow(orgA)
    expect(row!.status).toBe('ACTIVE')
    // What the carrier approved is what the renter saw.
    const sim = await prisma.simulatedTwilioAccount.findUniqueOrThrow({ where: { accountSid: row!.config.accountSid! } })
    expect(sim.optInDescription).toBe(row!.config.optInDescription)
    // ACTIVE is where polling stops.
    expect(await pollTwilioProvisioning(orgA)).toBeNull()
    expect((await sms(orgA, STRANGER)).status).toBe('SENT')
  })

  it('retires: the subaccount closes, the number is released, and nobody is texted', async () => {
    const before = (await twilioRow(orgA))!
    expect(await retireTwilioProvisioning(orgA)).not.toBeNull()
    const row = (await twilioRow(orgA))!
    expect(row.status).toBe('RETIRED')
    expect(row.config.phoneNumber).toBeUndefined()
    expect((await orgIntegration(orgA, 'TWILIO'))!.secret).toBeNull()
    const sim = await prisma.simulatedTwilioAccount.findUniqueOrThrow({ where: { accountSid: before.config.accountSid! } })
    expect(sim).toMatchObject({ phoneNumber: null })
    expect(sim.closedAt).not.toBeNull()
    expect(await sms(orgA, OWNER_PHONE)).toEqual({ status: 'SUPPRESSED', suppressedReason: 'unsupported_channel' })
  })

  it("shows Twilio's failure reason verbatim", async () => {
    const orgB = await seedOrg('b')
    await startTwilioProvisioning(orgB, '512')
    const reason = `Brand vetting failed: EIN ${stamp} does not match the legal name on file (30794)`
    await prisma.simulatedTwilioAccount.update({
      where: { accountSid: (await twilioRow(orgB))!.config.accountSid! },
      data: { failBrandWith: reason },
    })
    await pollTwilioProvisioning(orgB)
    const row = (await twilioRow(orgB))!
    expect(row).toMatchObject({ status: 'FAILED', statusReason: reason })
    expect(row.config).toMatchObject({ brandStatus: 'FAILED', brandReason: reason })
    expect(await smsSendRefusal(orgB, STRANGER)).toBe('campaign_not_approved')
  })

  it("leaves org #0, which has no row, on the env account (D-362)", async () => {
    expect(await prisma.orgIntegration.findFirst({ where: { orgId: 'org_0', provider: 'TWILIO' } })).toBeNull()
    expect(await smsSendRefusal('org_0', STRANGER)).toBeNull()
  })
})
