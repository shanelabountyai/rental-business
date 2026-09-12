import { describe, expect, it } from 'vitest'
import type { DayCountRule } from '../scheduling/deadline.ts'
import {
  noticePeriodCheck,
  nonRenewalNoticeText,
  validateJustCauseStatement,
  validateNoticePeriodOverride,
} from './notice-to-vacate.ts'

const GIVEN = '2026-08-01'
const EFFECTIVE_45_OUT = '2026-09-15' // 45 days

const CALENDAR: DayCountRule = { dayCountBasis: 'CALENDAR', observedHolidays: [] }
// 2026-09-05 is a Saturday, 09-06 a Sunday, 09-07 Labor Day - the same
// three-day run deadline.test.ts uses, so the two files can be read together.
const BUSINESS: DayCountRule = {
  dayCountBasis: 'BUSINESS',
  observedHolidays: ['2026-09-07'],
}

describe('noticePeriodCheck', () => {
  it('passes cleanly with no configured requirement', () => {
    const decision = noticePeriodCheck({
      givenOn: GIVEN,
      effectiveOn: EFFECTIVE_45_OUT,
      noticeToVacateDays: null,
      dayCount: CALENDAR,
    })
    expect(decision).toEqual({ basis: 'within_limits', needsOverride: false, daysGiven: 45 })
  })

  it('passes exactly at the required period', () => {
    const decision = noticePeriodCheck({
      givenOn: GIVEN,
      effectiveOn: EFFECTIVE_45_OUT,
      noticeToVacateDays: 45,
      dayCount: CALENDAR,
    })
    expect(decision).toEqual({ basis: 'within_limits', needsOverride: false, daysGiven: 45 })
  })

  it('needs override when short, and says how short', () => {
    const decision = noticePeriodCheck({
      givenOn: GIVEN,
      effectiveOn: EFFECTIVE_45_OUT,
      noticeToVacateDays: 60,
      dayCount: CALENDAR,
    })
    expect(decision).toEqual({
      basis: 'insufficient_notice',
      needsOverride: true,
      daysGiven: 45,
      requiredDays: 60,
      shortfallDays: 15,
      earliestOn: '2026-09-30', // 1 Aug + 60 calendar days
    })
  })

  it('an effective date before the given date is simply a negative days-given, not a crash', () => {
    const decision = noticePeriodCheck({
      givenOn: EFFECTIVE_45_OUT,
      effectiveOn: GIVEN,
      noticeToVacateDays: 30,
      dayCount: CALENDAR,
    })
    expect(decision.basis).toBe('insufficient_notice')
    expect(decision.daysGiven).toBeLessThan(0)
  })
})

  // R-200 (review finding 14). The defect this item exists to fix, in the
  // direction that actually costs somebody something: the same notice, the
  // same dates, waved through in a calendar state and correctly flagged in a
  // business-day one.
  //
  // Friday 4 September, three days' required notice, tenancy to end
  // Wednesday 9 September. Calendar: the period ran out on the 7th, so the
  // 9th is fine. Business days: Saturday, Sunday and Labor Day do not count,
  // so three business days from Friday is Thursday the 10th and the 9th is a
  // day short.
  it('counts BUSINESS days, and flags a notice a calendar count waved through', () => {
    const calendar = noticePeriodCheck({
      givenOn: '2026-09-04',
      effectiveOn: '2026-09-09',
      noticeToVacateDays: 3,
      dayCount: CALENDAR,
    })
    expect(calendar.basis).toBe('within_limits')
    expect(calendar.needsOverride).toBe(false)
    expect(calendar.daysGiven).toBe(5)

    const business = noticePeriodCheck({
      givenOn: '2026-09-04',
      effectiveOn: '2026-09-09',
      noticeToVacateDays: 3,
      dayCount: BUSINESS,
    })
    expect(business.basis).toBe('insufficient_notice')
    expect(business.needsOverride).toBe(true)
    // Two business days given, one short, and the date staff can act on.
    expect(business.daysGiven).toBe(2)
    expect(business.shortfallDays).toBe(1)
    expect(business.earliestOn).toBe('2026-09-10')
  })

  it('reports the honest day count on each basis, and BUSINESS is never the looser one', () => {
    // Friday 4 September to Wednesday 16 September is twelve calendar days
    // and seven business ones - the weekend, Labor Day, and the following
    // weekend all drop out.
    expect(
      noticePeriodCheck({
        givenOn: '2026-09-04',
        effectiveOn: '2026-09-16',
        noticeToVacateDays: null,
        dayCount: CALENDAR,
      }).daysGiven,
    ).toBe(12)
    expect(
      noticePeriodCheck({
        givenOn: '2026-09-04',
        effectiveOn: '2026-09-16',
        noticeToVacateDays: null,
        dayCount: BUSINESS,
      }).daysGiven,
    ).toBe(7)

    // THE DIRECTION THAT CANNOT COME FROM THE BASIS, written down so the
    // next reader does not go looking for it here. Counting only business
    // days always lands the deadline on or after the calendar one, so for a
    // given required number BUSINESS can only ever flag MORE notices than
    // CALENDAR, never fewer. The review's other failure - demanding an
    // override for a notice that was fine - was real but came from
    // somewhere else: the CALL SITES divided a mid-afternoon instant by a
    // UTC-midnight date and floored the part-day away, so a tenant giving
    // exactly thirty days was told they had given twenty-nine. That is
    // fixed by these two ends being calendar days at all, which is a thing
    // the type now enforces rather than a case this file can exercise.
    const required = 8
    const business = noticePeriodCheck({
      givenOn: '2026-09-04',
      effectiveOn: '2026-09-16',
      noticeToVacateDays: required,
      dayCount: BUSINESS,
    })
    expect(business.basis).toBe('insufficient_notice')
    expect(business.earliestOn).toBe('2026-09-17')
    expect(
      noticePeriodCheck({
        givenOn: '2026-09-04',
        effectiveOn: '2026-09-16',
        noticeToVacateDays: required,
        dayCount: CALENDAR,
      }).basis,
    ).toBe('within_limits')
  })

  it('is sufficient exactly ON the earliest lawful day, not a day after it', () => {
    // The boundary the whole check turns on, pinned on the basis where it
    // is least obvious: the eighth business day after Friday 4 September is
    // Thursday the 17th, and a tenancy ending that day is good notice.
    const decision = noticePeriodCheck({
      givenOn: '2026-09-04',
      effectiveOn: '2026-09-17',
      noticeToVacateDays: 8,
      dayCount: BUSINESS,
    })
    expect(decision.basis).toBe('within_limits')
    expect(decision.needsOverride).toBe(false)
    expect(decision.daysGiven).toBe(8)
  })

  it('an observed holiday a state has not filed is counted as a working day', () => {
    // Not a bug, and `computeCoverage` says so on the screen that gates a
    // state going effective - but it shortens a notice period, so it is
    // pinned here rather than left to be discovered.
    const noHolidays: DayCountRule = { dayCountBasis: 'BUSINESS', observedHolidays: [] }
    expect(
      noticePeriodCheck({
        givenOn: '2026-09-04',
        effectiveOn: '2026-09-09',
        noticeToVacateDays: 3,
        dayCount: noHolidays,
      }).basis,
    ).toBe('within_limits')
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
      effectiveOn: '2026-10-01',
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

  // R-200. This notice is SERVED ON A TENANT and the date is its operative
  // sentence. `effectiveOn` used to be a `Date` formatted through the
  // property's timezone - and it arrives from `parseLeaseDate` as UTC
  // midnight, so every US property rendered the day BEFORE the tenancy
  // actually ended: "Wednesday, September 30, 2026" for a tenancy ending on
  // 1 October. Exactly the R-042 defect, in an outbound legal document.
  it('states the end date as the day it actually is, with no timezone near it', () => {
    const text = nonRenewalNoticeText({
      tenantName: 'Jordan Rivera',
      addressLine1: '12 Oak St',
      unitName: '',
      effectiveOn: '2026-10-01',
      justCauseStatement: null,
      noticeToVacateDays: null,
    })
    expect(text).toContain('Thursday, October 1, 2026')
    expect(text).not.toContain('September 30')
  })

  it('includes the just-cause statement and the notice-period line when given', () => {
    const text = nonRenewalNoticeText({
      tenantName: 'Jordan Rivera',
      addressLine1: '12 Oak St',
      unitName: '',
      effectiveOn: '2026-10-01',
      justCauseStatement: 'Owner is moving into the unit.',
      noticeToVacateDays: 60,
    })
    expect(text).toContain('Reason for non-renewal: Owner is moving into the unit.')
    expect(text).toContain("at least 60 days' notice")
  })
})
