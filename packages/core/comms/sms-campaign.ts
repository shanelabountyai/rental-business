// A2P 10DLC per org (R-292b, PRD 10 §3.1): the vocabulary Twilio's brand and
// campaign reviews report in, how the two roll up into the org's one TWILIO
// row, and the send gate. Pure - the caller loads the row and the owners.

import { normalizePhone } from './phone.ts'

export const REVIEW_STATUSES = ['PENDING', 'IN_REVIEW', 'APPROVED', 'FAILED'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/// `OrgIntegration.status` for a TWILIO row this item provisioned.
export type TwilioRowStatus = 'PROVISIONING' | 'ACTIVE' | 'FAILED' | 'RETIRED'

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && (REVIEW_STATUSES as readonly string[]).includes(value)
}

/**
 * One step of a review per poll, in Twilio's order: PENDING, IN_REVIEW,
 * APPROVED. FAILED and APPROVED are where a review stops.
 */
export function nextReviewStatus(status: ReviewStatus): ReviewStatus {
  return status === 'PENDING' ? 'IN_REVIEW' : status === 'IN_REVIEW' ? 'APPROVED' : status
}

/**
 * The row's overall status and the reason shown for it: a failed brand or
 * campaign is the row's failure, with the provider's words verbatim; an
 * approved campaign is a live sender; anything else is still provisioning.
 */
export function twilioRowStatus(review: {
  brandStatus: ReviewStatus
  brandReason?: string | null
  campaignStatus?: ReviewStatus | null
  campaignReason?: string | null
}): { status: TwilioRowStatus; statusReason: string | null } {
  if (review.brandStatus === 'FAILED') return { status: 'FAILED', statusReason: review.brandReason || null }
  if (review.campaignStatus === 'FAILED') return { status: 'FAILED', statusReason: review.campaignReason || null }
  if (review.campaignStatus === 'APPROVED') return { status: 'ACTIVE', statusReason: null }
  return { status: 'PROVISIONING', statusReason: null }
}

export type SmsCampaignRefusal = 'campaign_not_approved' | 'unsupported_channel'

/**
 * May this org text `to` (PRD 10 §3.1 step 3)? Null means yes.
 *
 * - No TWILIO row: yes. Org #0 on the env account is unchanged (D-362), and
 *   any other org with no row has no sender, which `supports()` already says.
 * - A RETIRED row: no, to anyone - there is no number left to send from.
 * - Otherwise only once the campaign is APPROVED, except to the phone of one
 *   of the org's active owners: carriers block unregistered 10DLC traffic,
 *   and the owner's own handset is how the org tests its number meanwhile.
 *   "Verified" is the owner's `StaffUser.phone`; no verification flow exists.
 */
export function smsCampaignRefusal(input: {
  row: { status: string; campaignStatus?: string | null } | null
  to: string
  ownerPhones: readonly (string | null)[]
}): SmsCampaignRefusal | null {
  if (!input.row) return null
  if (input.row.status === 'RETIRED') return 'unsupported_channel'
  if (input.row.campaignStatus === 'APPROVED') return null
  const to = normalizePhone(input.to)
  if (to && input.ownerPhones.some((phone) => normalizePhone(phone) === to)) return null
  return 'campaign_not_approved'
}

