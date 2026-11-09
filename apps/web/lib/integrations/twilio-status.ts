import 'server-only'

import {
  type ReviewStatus,
  a2pCampaignReview,
  isReviewStatus,
  isTollFree,
  tollFreeReview,
} from '@rental/core/comms'
import { orgIntegration } from './store.ts'
import { type TwilioConfig, twilioConfig } from '@/lib/notifications/live-adapter.ts'

// R-273 (D-407): the org's texting number and whether carriers will carry it,
// read from Twilio on the credentials the live adapter would send on - so the
// panel describes the sender that actually sends, never a second opinion.
//
// A toll-free number reports its toll-free verification; a local number its
// A2P 10DLC campaign. A row the SIMULATED provisioner made (R-292b) has SIDs
// no real Twilio knows, so its stored statuses are shown instead.

export type TextingStatus =
  | { kind: 'none' }
  | { kind: 'unreachable' }
  | {
      kind: 'toll_free' | '10dlc'
      phoneNumber: string | null
      /// Null: nothing has been submitted for review.
      status: ReviewStatus | null
      /// Twilio's words, verbatim, when it refused.
      reason: string | null
    }

const TIMEOUT_MS = 10_000
const API = 'https://messaging.twilio.com/v1'

async function get(config: TwilioConfig, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Twilio ${path} returned ${response.status}`)
  return (await response.json()) as Record<string, unknown>
}

function first(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const list = payload[key]
  return Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export async function textingStatus(orgId: string): Promise<TextingStatus> {
  const row = await orgIntegration(orgId, 'TWILIO')
  if (row?.config.provisionedBy === 'simulated') {
    const c = row.config
    const status = isReviewStatus(c.campaignStatus) ? c.campaignStatus : null
    return {
      kind: '10dlc',
      phoneNumber: text(c.phoneNumber),
      status,
      reason: status === 'FAILED' ? text(c.campaignReason) ?? text(c.brandReason) : null,
    }
  }

  const config = await twilioConfig(orgId)
  if (!config) return { kind: 'none' }

  try {
    const number = first(await get(config, `/Services/${config.serviceSid}/PhoneNumbers`), 'phone_numbers')
    const phoneNumber = text(number?.phone_number)
    if (phoneNumber && isTollFree(phoneNumber)) {
      const verification = first(
        await get(config, `/Tollfree/Verifications?TollfreePhoneNumberSid=${encodeURIComponent(String(number?.sid))}`),
        'verifications',
      )
      const status = tollFreeReview(text(verification?.status))
      return {
        kind: 'toll_free',
        phoneNumber,
        status,
        reason: status === 'FAILED' ? text(verification?.rejection_reason) : null,
      }
    }
    const campaign = first(await get(config, `/Services/${config.serviceSid}/Compliance/Usa2p`), 'compliance')
    // ponytail: no 10DLC failure reason yet - Usa2p's error shape has never
    // been seen from a real account; read it once a local number exists.
    return { kind: '10dlc', phoneNumber, status: a2pCampaignReview(text(campaign?.campaign_status)), reason: null }
  } catch (error) {
    console.error('[twilio-status] could not read registration', error)
    return { kind: 'unreachable' }
  }
}
