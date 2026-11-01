import 'server-only'

import { randomBytes, randomInt } from 'node:crypto'
import {
  type ReviewStatus,
  isReviewStatus,
  nextReviewStatus,
  optOutReply,
  smsCampaignRefusal,
  twilioRowStatus,
} from '@rental/core/comms'
import { prisma } from '@rental/db'
import { messagingSettings, smsDisclosureFor } from '@/lib/comms/messaging-settings.ts'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { orgIdForTwilioNumber, saveOrgIntegration } from './store.ts'

// Per-org Twilio provisioning (R-292b, PRD 10 §3.1): a subaccount, a number in
// the org's area code, a Messaging Service, then the A2P 10DLC brand and
// campaign, each a status the console shows with Twilio's reason verbatim.
//
// SIMULATED (D-7). `TwilioProvisioner` is the seam a real driver replaces;
// the simulator below keeps its OWN state in `SimulatedTwilioAccount` (D-27)
// and answers polls from that, never from our `OrgIntegration.config`, so
// what we believe and what "Twilio" says can differ until a poll reconciles
// them. A row it provisioned carries `provisionedBy: 'simulated'`, and the
// live adapter never sends on one: its SIDs exist nowhere but here.

export type ReviewState = { status: ReviewStatus; reason: string | null }

export interface TwilioProvisioner {
  readonly name: string
  createSubaccount(friendlyName: string): Promise<{ accountSid: string; authToken: string }>
  /// An E.164 number in `areaCode`, nobody else's.
  buyNumber(accountSid: string, areaCode: string): Promise<string>
  createMessagingService(accountSid: string, phoneNumber: string): Promise<string>
  createBrand(accountSid: string, legalName: string): Promise<ReviewState>
  createCampaign(accountSid: string, optInDescription: string, sampleMessages: string[]): Promise<ReviewState>
  poll(accountSid: string): Promise<{ brand: ReviewState | null; campaign: ReviewState | null }>
  closeSubaccount(accountSid: string): Promise<void>
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex')

function review(status: string | null, reason: string | null): ReviewState | null {
  return isReviewStatus(status) ? { status, reason } : null
}

class SimulatedTwilioProvisioner implements TwilioProvisioner {
  readonly name = 'simulated'

  async createSubaccount(friendlyName: string) {
    const accountSid = `AC${hex(16)}`
    await prisma.simulatedTwilioAccount.create({ data: { accountSid, friendlyName } })
    console.info(`[twilio:simulated] subaccount ${accountSid} for ${friendlyName}`)
    return { accountSid, authToken: hex(16) }
  }

  async buyNumber(accountSid: string, areaCode: string) {
    for (let attempt = 0; attempt < 10; attempt++) {
      // Exchange 200-999: a NANP exchange never starts with 0 or 1.
      const number = `+1${areaCode}${randomInt(200, 1000)}${String(randomInt(0, 10_000)).padStart(4, '0')}`
      // A number some row of ours already names is "taken" too: a real
      // inventory would never sell it twice, and the unique index would refuse.
      if (await orgIdForTwilioNumber(number)) continue
      try {
        await prisma.simulatedTwilioAccount.update({ where: { accountSid }, data: { phoneNumber: number } })
        return number
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
      }
    }
    throw new Error(`No number available in area code ${areaCode}.`)
  }

  async createMessagingService(accountSid: string) {
    const messagingServiceSid = `MG${hex(16)}`
    await prisma.simulatedTwilioAccount.update({ where: { accountSid }, data: { messagingServiceSid } })
    return messagingServiceSid
  }

  async createBrand(accountSid: string, legalName: string) {
    await prisma.simulatedTwilioAccount.update({
      where: { accountSid },
      data: { friendlyName: legalName, brandStatus: 'PENDING', brandReason: null },
    })
    return { status: 'PENDING' as const, reason: null }
  }

  async createCampaign(accountSid: string, optInDescription: string) {
    await prisma.simulatedTwilioAccount.update({
      where: { accountSid },
      data: { optInDescription, campaignStatus: 'PENDING', campaignReason: null },
    })
    return { status: 'PENDING' as const, reason: null }
  }

  /// One review step per poll: the brand first, then the campaign.
  async poll(accountSid: string) {
    const account = await prisma.simulatedTwilioAccount.findUnique({ where: { accountSid } })
    if (!account || account.closedAt) throw new Error(`Twilio has no open subaccount ${accountSid}.`)
    let brand = review(account.brandStatus, account.brandReason)
    let campaign = review(account.campaignStatus, account.campaignReason)
    const step = (state: ReviewState, failWith: string | null): ReviewState =>
      failWith ? { status: 'FAILED', reason: failWith } : { status: nextReviewStatus(state.status), reason: null }

    if (brand && brand.status !== 'APPROVED' && brand.status !== 'FAILED') {
      brand = step(brand, account.failBrandWith)
    } else if (campaign && campaign.status !== 'APPROVED' && campaign.status !== 'FAILED') {
      campaign = step(campaign, account.failCampaignWith)
    }
    await prisma.simulatedTwilioAccount.update({
      where: { accountSid },
      data: {
        brandStatus: brand?.status ?? null,
        brandReason: brand?.reason ?? null,
        campaignStatus: campaign?.status ?? null,
        campaignReason: campaign?.reason ?? null,
      },
    })
    return { brand, campaign }
  }

  async closeSubaccount(accountSid: string) {
    // Closing releases the number back to the inventory.
    await prisma.simulatedTwilioAccount.updateMany({
      where: { accountSid, closedAt: null },
      data: { closedAt: new Date(), phoneNumber: null },
    })
  }
}

export const twilioProvisioner: TwilioProvisioner = new SimulatedTwilioProvisioner()

export const AREA_CODE = /^[2-9][0-9]{2}$/

/// The row as the console and the gate read it. Config values are strings.
export type TwilioRow = { id: string; status: string; statusReason: string | null; config: Record<string, string> }

function strings(config: unknown): Record<string, string> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  return Object.fromEntries(
    Object.entries(config as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
  )
}

export async function twilioRow(orgId: string): Promise<TwilioRow | null> {
  const row = await prisma.orgIntegration.findUnique({
    where: { orgId_provider: { orgId, provider: 'TWILIO' } },
    select: { id: true, status: true, statusReason: true, config: true },
  })
  return row ? { id: row.id, status: row.status, statusReason: row.statusReason, config: strings(row.config) } : null
}

/**
 * Starts provisioning. Refused while a row is PROVISIONING or ACTIVE; a
 * NOT_STARTED, FAILED or RETIRED row is started again on a new subaccount. The claim is a
 * conditional write, so two admins pressing at once start one.
 */
export async function startTwilioProvisioning(
  orgId: string,
  areaCode: string,
): Promise<{ ok: true; row: TwilioRow } | { ok: false; error: string }> {
  if (!AREA_CODE.test(areaCode)) return { ok: false, error: 'An area code is three digits and cannot start with 0 or 1.' }
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } })
  if (!org) return { ok: false, error: 'That organisation no longer exists.' }

  const previous = await twilioRow(orgId)
  const claimed = previous
    ? (
        await prisma.orgIntegration.updateMany({
          where: { orgId, provider: 'TWILIO', status: { in: ['NOT_STARTED', 'FAILED', 'RETIRED'] } },
          data: { status: 'PROVISIONING', statusReason: null },
        })
      ).count === 1
    : await prisma.orgIntegration
        .create({ data: { orgId, provider: 'TWILIO', status: 'PROVISIONING' } })
        .then(() => true, (error) => (isUniqueViolation(error) ? false : Promise.reject(error)))
  if (!claimed) return { ok: false, error: 'SMS provisioning has already started for this organisation.' }

  try {
    if (previous?.status === 'FAILED' && previous.config.accountSid) {
      await twilioProvisioner.closeSubaccount(previous.config.accountSid)
    }
    const optInDescription = await smsDisclosureFor(orgId)
    const { accountSid, authToken } = await twilioProvisioner.createSubaccount(org.name)
    const phoneNumber = await twilioProvisioner.buyNumber(accountSid, areaCode)
    const messagingServiceSid = await twilioProvisioner.createMessagingService(accountSid, phoneNumber)
    const brand = await twilioProvisioner.createBrand(accountSid, org.name)
    const now = new Date().toISOString()
    const config: Record<string, string> = {
      provisionedBy: twilioProvisioner.name,
      accountSid,
      phoneNumber,
      messagingServiceSid,
      brandStatus: brand.status,
      startedAt: now,
      polledAt: now,
      // PRD 10 §3.3: the words the inquiry form shows, quoted to the carrier.
      optInDescription,
    }
    if (brand.reason) config.brandReason = brand.reason
    const { status, statusReason } = twilioRowStatus({ brandStatus: brand.status, brandReason: brand.reason })
    await saveOrgIntegration(orgId, 'TWILIO', { status, statusReason, config, secret: authToken })
    return { ok: true, row: (await twilioRow(orgId))! }
  } catch (error) {
    // The claim is released as FAILED with our own words, so the console
    // shows why and the next press can start again.
    const reason = error instanceof Error ? error.message : 'Provisioning stopped unexpectedly.'
    await saveOrgIntegration(orgId, 'TWILIO', { status: 'FAILED', statusReason: reason })
    return { ok: false, error: reason }
  }
}

/**
 * Asks Twilio where the reviews stand and records the answer (on demand and
 * nightly). Only a PROVISIONING row is polled: ACTIVE, FAILED and RETIRED are
 * where a provisioning stops. Once the brand is APPROVED the campaign is
 * registered, quoting the opt-in text saved when it started.
 */
export async function pollTwilioProvisioning(
  orgId: string,
): Promise<{ before: TwilioRow; after: TwilioRow } | null> {
  const before = await twilioRow(orgId)
  const accountSid = before?.config.accountSid
  if (!before || before.status !== 'PROVISIONING' || !accountSid) return null

  const polled = await twilioProvisioner.poll(accountSid)
  const brand = polled.brand
  let campaign = polled.campaign
  if (brand?.status === 'APPROVED' && !campaign) {
    const { businessName } = await messagingSettings(orgId)
    // ponytail: two sample messages from the org's own keyword replies; a
    // real registration wants ones drawn from the templates it will send.
    campaign = await twilioProvisioner.createCampaign(
      accountSid,
      before.config.optInDescription ?? '',
      [optOutReply('HELP', businessName), optOutReply('START', businessName)].filter((m): m is string => m !== null),
    )
  }

  const config: Record<string, string> = { ...before.config, polledAt: new Date().toISOString() }
  for (const [key, state] of [['brand', brand], ['campaign', campaign]] as const) {
    if (!state) continue
    config[`${key}Status`] = state.status
    if (state.reason) config[`${key}Reason`] = state.reason
    else delete config[`${key}Reason`]
  }
  const { status, statusReason } = twilioRowStatus({
    brandStatus: brand?.status ?? 'PENDING',
    brandReason: brand?.reason,
    campaignStatus: campaign?.status,
    campaignReason: campaign?.reason,
  })
  // Conditional on PROVISIONING, so a retire pressed meanwhile is not undone.
  const { count } = await prisma.orgIntegration.updateMany({
    where: { orgId, provider: 'TWILIO', status: 'PROVISIONING' },
    data: { status, statusReason, config },
  })
  return count === 1 ? { before, after: { id: before.id, status, statusReason, config } } : null
}

/// Closes the subaccount and keeps the row as RETIRED: no number, no secret,
/// and the send gate refuses every text on it.
export async function retireTwilioProvisioning(orgId: string): Promise<{ before: TwilioRow } | null> {
  const before = await twilioRow(orgId)
  if (!before || before.status === 'RETIRED') return null
  if (before.config.accountSid) await twilioProvisioner.closeSubaccount(before.config.accountSid)
  const { phoneNumber: _released, ...config } = before.config
  await saveOrgIntegration(orgId, 'TWILIO', {
    status: 'RETIRED',
    statusReason: null,
    config: { ...config, retiredAt: new Date().toISOString() },
    secret: null,
  })
  return { before }
}

/**
 * The send gate's database half (PRD 10 §3.1 step 3): the org's TWILIO row and
 * its active owners' phones, for `smsCampaignRefusal`. The owners are read
 * only when the answer depends on them.
 */
export async function smsSendRefusal(orgId: string, to: string) {
  const row = await twilioRow(orgId)
  const gate = row && { status: row.status, campaignStatus: row.config.campaignStatus ?? null }
  if (!gate || gate.status === 'RETIRED' || gate.campaignStatus === 'APPROVED') {
    return smsCampaignRefusal({ row: gate, to, ownerPhones: [] })
  }
  const owners = await prisma.staffUser.findMany({
    where: {
      active: true,
      phone: { not: null },
      orgMemberships: { some: { orgId, removedAt: null } },
      assignments: { some: { orgId, revokedAt: null, role: { key: 'owner' } } },
    },
    select: { phone: true },
  })
  return smsCampaignRefusal({ row: gate, to, ownerPhones: owners.map((o) => o.phone) })
}
