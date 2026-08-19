import { describe, expect, it } from 'vitest'
import { renewalRentCheck, validateRenewalOverride } from './renewal.ts'

const OFFERED = new Date('2026-08-01T00:00:00.000Z')
const EFFECTIVE_45_OUT = new Date('2026-09-15T00:00:00.000Z') // 45 days' notice

describe('renewalRentCheck', () => {
  it('a hold or a decrease needs neither check, even with a cap and a notice rule configured', () => {
    const held = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 150_000,
      effectiveOn: OFFERED, // zero notice - would fail if the increase check ran at all
      offeredOn: OFFERED,
      rentIncreaseCapPercentBps: 500,
      rentIncreaseNoticeDays: 60,
    })
    expect(held).toEqual({ basis: 'within_limits', blocked: false, needsOverride: false, increasePercentBps: 0 })

    const decreased = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 140_000,
      effectiveOn: OFFERED,
      offeredOn: OFFERED,
      rentIncreaseCapPercentBps: 500,
      rentIncreaseNoticeDays: 60,
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
    })
    expect(decision.basis).toBe('capped')
    expect(decision.shortfallDays).toBeUndefined()
  })

  it('warns and needs an override when notice is short, even with no cap configured', () => {
    const decision = renewalRentCheck({
      currentRentCents: 150_000,
      proposedRentCents: 165_000,
      effectiveOn: new Date('2026-08-15T00:00:00.000Z'), // 14 days out
      offeredOn: OFFERED,
      rentIncreaseCapPercentBps: null,
      rentIncreaseNoticeDays: 30,
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
    })
    expect(decision.basis).toBe('within_limits')
  })
})

describe('validateRenewalOverride', () => {
  it('requires a stated reason', () => {
    expect(validateRenewalOverride(null)).toHaveLength(1)
    expect(validateRenewalOverride('  ')).toHaveLength(1)
    expect(validateRenewalOverride('Tenant asked to sign late; approved by owner.')).toHaveLength(0)
  })
})
