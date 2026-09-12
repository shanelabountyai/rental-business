import { describe, expect, it } from 'vitest'
import type { DayCountRule } from '../scheduling/deadline.ts'
import { renewalRentCheck, validateRenewalOverride } from './renewal.ts'

const OFFERED = '2026-08-01'
const EFFECTIVE_45_OUT = '2026-09-15' // 45 days' notice

const CALENDAR: DayCountRule = { dayCountBasis: 'CALENDAR', observedHolidays: [] }
const BUSINESS: DayCountRule = {
  dayCountBasis: 'BUSINESS',
  observedHolidays: ['2026-09-07'], // Labor Day, as deadline.test.ts uses
}

describe('renewalRentCheck', () => {
  it('a hold or a decrease needs neither check, even with a cap and a notice rule configured', () => {
    const held = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 150_000,
      effectiveOn: OFFERED, // zero notice - would fail if the increase check ran at all
      offeredOn: OFFERED,
      rentIncreaseCapPercentBps: 500,
      rentIncreaseNoticeDays: 60,
      dayCount: CALENDAR,
    })
    expect(held).toEqual({ basis: 'within_limits', blocked: false, needsOverride: false, increasePercentBps: 0 })

    const decreased = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 140_000,
      effectiveOn: OFFERED,
      offeredOn: OFFERED,
      rentIncreaseCapPercentBps: 500,
      rentIncreaseNoticeDays: 60,
      dayCount: CALENDAR,
    })
    expect(decreased.blocked).toBe(false)
    expect(decreased.needsOverride).toBe(false)
  })

  it('a raise within an unconfigured cap and notice period passes cleanly', () => {
    const decision = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 160_000,
      effectiveOn: EFFECTIVE_45_OUT,
      offeredOn: OFFERED,
      rentIncreaseCapPercentBps: null,
      rentIncreaseNoticeDays: null,
      dayCount: CALENDAR,
    })
    expect(decision).toEqual({
      basis: 'within_limits',
      blocked: false,
      needsOverride: false,
      increasePercentBps: 667, // 10,000/150,000 rounded
    })
  })

  it('blocks, with no override, when the raise exceeds the statutory cap', () => {
    const decision = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 165_000, // 10% - over a 5% cap
      effectiveOn: EFFECTIVE_45_OUT,
      offeredOn: OFFERED,
      rentIncreaseCapPercentBps: 500,
      rentIncreaseNoticeDays: 30, // satisfied - cap short-circuits before this is even reached
      dayCount: CALENDAR,
    })
    expect(decision.basis).toBe('capped')
    expect(decision.blocked).toBe(true)
    expect(decision.needsOverride).toBe(false)
    expect(decision.maxAllowedCents).toBe(157_500) // 150,000 * 1.05
  })

  it('a cap violation is checked BEFORE notice, even when both would fail', () => {
    const decision = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 165_000,
      effectiveOn: OFFERED, // zero notice too
      offeredOn: OFFERED,
      rentIncreaseCapPercentBps: 500,
      rentIncreaseNoticeDays: 60,
      dayCount: CALENDAR,
    })
    expect(decision.basis).toBe('capped')
    expect(decision.shortfallDays).toBeUndefined()
  })

  it('warns and needs an override when notice is short, even with no cap configured', () => {
    const decision = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 165_000,
      effectiveOn: '2026-08-15', // 14 days out
      offeredOn: OFFERED,
      rentIncreaseCapPercentBps: null,
      rentIncreaseNoticeDays: 30,
      dayCount: CALENDAR,
    })
    expect(decision.basis).toBe('insufficient_notice')
    expect(decision.blocked).toBe(false)
    expect(decision.needsOverride).toBe(true)
    expect(decision.noticeDaysGiven).toBe(14)
    expect(decision.shortfallDays).toBe(16)
  })

  it('exact-boundary notice (equal to the required days) is sufficient, not short', () => {
    const decision = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 160_000,
      effectiveOn: EFFECTIVE_45_OUT, // exactly 45 days
      offeredOn: OFFERED,
      rentIncreaseCapPercentBps: null,
      rentIncreaseNoticeDays: 45,
      dayCount: CALENDAR,
    })
    expect(decision.basis).toBe('within_limits')
  })
})

  // R-200 (review finding 14), the rent-increase half. Same shape as
  // `noticePeriodCheck`'s own business-day test and the same calendar run:
  // three days' required notice from Friday 4 September is the 7th on a
  // calendar count and the 10th on a business-day one.
  it('counts the notice period the way the jurisdiction counts days', () => {
    const calendar = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 165_000,
      effectiveOn: '2026-09-09',
      offeredOn: '2026-09-04',
      rentIncreaseCapPercentBps: null,
      rentIncreaseNoticeDays: 3,
      dayCount: CALENDAR,
    })
    expect(calendar.basis).toBe('within_limits')

    const business = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 165_000,
      effectiveOn: '2026-09-09',
      offeredOn: '2026-09-04',
      rentIncreaseCapPercentBps: null,
      rentIncreaseNoticeDays: 3,
      dayCount: BUSINESS,
    })
    expect(business.basis).toBe('insufficient_notice')
    expect(business.needsOverride).toBe(true)
    expect(business.noticeDaysGiven).toBe(2)
    expect(business.shortfallDays).toBe(1)
    expect(business.earliestOn).toBe('2026-09-10')
  })

  it('still checks the cap first on a business-day basis', () => {
    // The ordering the file's own header turns on: a rent nobody may
    // lawfully charge is the whole answer, whatever the notice was.
    const decision = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 165_000,
      effectiveOn: '2026-09-09',
      offeredOn: '2026-09-04',
      rentIncreaseCapPercentBps: 500,
      rentIncreaseNoticeDays: 3,
      dayCount: BUSINESS,
    })
    expect(decision.basis).toBe('capped')
    expect(decision.shortfallDays).toBeUndefined()
    expect(decision.earliestOn).toBeUndefined()
  })

describe('validateRenewalOverride', () => {
  it('requires a stated reason', () => {
    expect(validateRenewalOverride(null)).toHaveLength(1)
    expect(validateRenewalOverride('  ')).toHaveLength(1)
    expect(validateRenewalOverride('Tenant asked to sign late; approved by owner.')).toHaveLength(0)
  })
})
