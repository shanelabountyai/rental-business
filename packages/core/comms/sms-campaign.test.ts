import { describe, expect, it } from 'vitest'
import { nextReviewStatus, smsCampaignRefusal, twilioRowStatus } from './sms-campaign.ts'

describe('the 10DLC send gate (R-292b)', () => {
  const owners = ['(512) 555-0100', null]
  const gate = (row: { status: string; campaignStatus?: string | null } | null, to: string) =>
    smsCampaignRefusal({ row, to, ownerPhones: owners })

  it('leaves an org with no Twilio row alone (org #0 on the env, D-362)', () => {
    expect(gate(null, '+15125550199')).toBeNull()
  })

  it('texts only the owners until the campaign is approved', () => {
    const row = { status: 'PROVISIONING', campaignStatus: 'IN_REVIEW' }
    expect(gate(row, '+15125550199')).toBe('campaign_not_approved')
    expect(gate(row, '+1 512 555 0100')).toBeNull()
    expect(gate({ status: 'FAILED', campaignStatus: 'FAILED' }, '+15125550199')).toBe('campaign_not_approved')
  })

  it('texts anyone once approved', () => {
    expect(gate({ status: 'ACTIVE', campaignStatus: 'APPROVED' }, '+15125550199')).toBeNull()
  })

  it('texts nobody, owners included, on a retired row', () => {
    expect(gate({ status: 'RETIRED', campaignStatus: 'APPROVED' }, '+15125550100')).toBe('unsupported_channel')
  })
})

describe('review progression', () => {
  it('moves one step per poll and stops at APPROVED or FAILED', () => {
    expect(nextReviewStatus('PENDING')).toBe('IN_REVIEW')
    expect(nextReviewStatus('IN_REVIEW')).toBe('APPROVED')
    expect(nextReviewStatus('APPROVED')).toBe('APPROVED')
    expect(nextReviewStatus('FAILED')).toBe('FAILED')
  })

  it('rolls the two reviews up into the row, with the failing reason verbatim', () => {
    expect(twilioRowStatus({ brandStatus: 'IN_REVIEW' })).toEqual({ status: 'PROVISIONING', statusReason: null })
    expect(twilioRowStatus({ brandStatus: 'FAILED', brandReason: 'EIN does not match' })).toEqual({
      status: 'FAILED',
      statusReason: 'EIN does not match',
    })
    expect(
      twilioRowStatus({ brandStatus: 'APPROVED', campaignStatus: 'FAILED', campaignReason: 'Opt-in unclear' }),
    ).toEqual({ status: 'FAILED', statusReason: 'Opt-in unclear' })
    expect(twilioRowStatus({ brandStatus: 'APPROVED', campaignStatus: 'APPROVED' })).toEqual({
      status: 'ACTIVE',
      statusReason: null,
    })
  })
})
