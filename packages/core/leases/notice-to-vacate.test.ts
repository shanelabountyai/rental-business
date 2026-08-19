import { describe, expect, it } from 'vitest'
import {
  noticePeriodCheck,
  nonRenewalNoticeText,
  validateJustCauseStatement,
  validateNoticePeriodOverride,
} from './notice-to-vacate.ts'

const GIVEN = new Date('2026-08-01T00:00:00.000Z')
const EFFECTIVE_45_OUT = new Date('2026-09-15T00:00:00.000Z') // 45 days

describe('noticePeriodCheck', () => {
  it('passes cleanly with no configured requirement', () => {
    const decision = noticePeriodCheck({
      givenOn: GIVEN,
      effectiveOn: EFFECTIVE_45_OUT,
      noticeToVacateDays: null,
    })
    expect(decision).toEqual({ basis: 'within_limits', needsOverride: false, daysGiven: 45 })
  })

  it('passes exactly at the required period', () => {
    const decision = noticePeriodCheck({
      givenOn: GIVEN,
      effectiveOn: EFFECTIVE_45_OUT,
      noticeToVacateDays: 45,
    })
    expect(decision).toEqual({ basis: 'within_limits', needsOverride: false, daysGiven: 45 })
  })

  it('needs override when short, and says how short', () => {
    const decision = noticePeriodCheck({
      givenOn: GIVEN,
      effectiveOn: EFFECTIVE_45_OUT,
      noticeToVacateDays: 60,
    })
    expect(decision).toEqual({
      basis: 'insufficient_notice',
      needsOverride: true,
      daysGiven: 45,
      requiredDays: 60,
      shortfallDays: 15,
    })
  })

  it('an effective date before the given date is simply a negative days-given, not a crash', () => {
    const decision = noticePeriodCheck({
      givenOn: EFFECTIVE_45_OUT,
      effectiveOn: GIVEN,
      noticeToVacateDays: 30,
    })
    expect(decision.basis).toBe('insufficient_notice')
    expect(decision.daysGiven).toBeLessThan(0)
  })
})

describe('validateNoticePeriodOverride', () => {
  it('requires a reason', () => {
    expect(validateNoticePeriodOverride(null)).toHaveLength(1)
    expect(validateNoticePeriodOverride('  ')).toHaveLength(1)
    expect(validateNoticePeriodOverride('tenant asked to leave early')).toHaveLength(0)
  })
})

describe('validateJustCauseStatement', () => {
  it('is silent when the jurisdiction does not require one', () => {
    expect(validateJustCauseStatement(false, null)).toHaveLength(0)
  })

  it('requires a stated cause when the jurisdiction does', () => {
    expect(validateJustCauseStatement(true, null)).toHaveLength(1)
    expect(validateJustCauseStatement(true, '  ')).toHaveLength(1)
    expect(validateJustCauseStatement(true, 'owner occupancy')).toHaveLength(0)
  })
})

describe('nonRenewalNoticeText', () => {
  it('drafts a plain, dated notice ending with the not-legal-advice disclaimer', () => {
    const text = nonRenewalNoticeText({
      tenantName: 'Jordan Rivera',
      addressLine1: '12 Oak St',
      unitName: 'Unit B',
      timezone: 'America/Chicago',
      effectiveOn: new Date('2026-10-01T00:00:00.000Z'),
      justCauseStatement: null,
      noticeToVacateDays: null,
    })
    expect(text).toContain('Jordan Rivera')
    expect(text).toContain('12 Oak St')
    expect(text).toContain('Unit B')
    expect(text).toContain('will not be renewed')
    expect(text.endsWith('It is not legal advice.')).toBe(true)
    expect(text).not.toContain('Reason for non-renewal')
  })

  it('includes the just-cause statement and the notice-period line when given', () => {
    const text = nonRenewalNoticeText({
      tenantName: 'Jordan Rivera',
      addressLine1: '12 Oak St',
      unitName: '',
      timezone: 'America/Chicago',
      effectiveOn: new Date('2026-10-01T00:00:00.000Z'),
      justCauseStatement: 'Owner is moving into the unit.',
      noticeToVacateDays: 60,
    })
    expect(text).toContain('Reason for non-renewal: Owner is moving into the unit.')
    expect(text).toContain("at least 60 days' notice")
  })
})
