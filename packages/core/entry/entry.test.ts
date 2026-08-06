import { describe, expect, it } from 'vitest'
import {
  earliestCompliantStart,
  entryDecision,
  entryNoticeText,
  validateOverride,
  validateSchedule,
} from './index.ts'

const START = new Date('2026-08-10T14:00:00Z')

function facts(over: Partial<Parameters<typeof entryDecision>[0]> = {}) {
  return {
    scheduledStart: START,
    noticeServedAt: new Date('2026-08-09T14:00:00Z'), // 24h before
    entryNoticeHours: 24,
    isEmergency: false,
    tenantPermissionGrantedAt: null,
    ...over,
  }
}

describe('entryDecision', () => {
  it('permits exactly at the required period - 24h notice for a 24h rule', () => {
    expect(entryDecision(facts())).toEqual({ basis: 'notice_served', permitted: true })
  })

  it('REFUSES one hour short, and says how short', () => {
    const decision = entryDecision(
      facts({ noticeServedAt: new Date('2026-08-09T15:00:00Z') }), // 23h
    )
    expect(decision.permitted).toBe(false)
    expect(decision.basis).toBe('insufficient_notice')
    expect(decision.requiredHours).toBe(24)
    expect(decision.shortfallHours).toBe(1)
  })

  it('rounds the shortfall UP, so a warning never understates the gap', () => {
    // 22.5 hours of notice against a 24-hour rule is 1.5 short; a person
    // reading the warning should be told 2.
    const decision = entryDecision(
      facts({ noticeServedAt: new Date('2026-08-09T15:30:00Z') }),
    )
    expect(decision.shortfallHours).toBe(2)
  })

  it('treats no notice at all as the full period short', () => {
    const decision = entryDecision(facts({ noticeServedAt: null }))
    expect(decision).toMatchObject({
      basis: 'insufficient_notice',
      permitted: false,
      shortfallHours: 24,
      requiredHours: 24,
    })
  })

  it('EMERGENCY outranks everything, including no notice whatsoever', () => {
    // You do not wait 24 hours to enter a unit that is flooding, and the
    // check must not even look at the clock first.
    const decision = entryDecision(
      facts({ isEmergency: true, noticeServedAt: null, entryNoticeHours: 48 }),
    )
    expect(decision).toEqual({ basis: 'emergency', permitted: true })
  })

  it('tenant permission outranks the notice period - consent is what notice substitutes for', () => {
    const decision = entryDecision(
      facts({
        noticeServedAt: null,
        tenantPermissionGrantedAt: new Date('2026-08-10T09:00:00Z'),
      }),
    )
    expect(decision).toEqual({ basis: 'tenant_permission', permitted: true })
  })

  it('IGNORES permission recorded after the visit had already started', () => {
    // A grant written down afterwards is a story, not consent. This
    // comparison is what stops a backdated note being treated as
    // authorization.
    const decision = entryDecision(
      facts({
        noticeServedAt: null,
        tenantPermissionGrantedAt: new Date('2026-08-10T16:00:00Z'), // after START
      }),
    )
    expect(decision.permitted).toBe(false)
    expect(decision.basis).toBe('insufficient_notice')
  })

  it('permits when the jurisdiction on file states no period', () => {
    const decision = entryDecision(facts({ entryNoticeHours: null, noticeServedAt: null }))
    expect(decision).toEqual({ basis: 'notice_served', permitted: true })
  })

  it('measures to the START of the window, not the end', () => {
    // A tenant is entitled to the full period before ANYBODY may arrive.
    // Notice served 24h before the window opens is compliant; the window's
    // length must not be allowed to pad it.
    const decision = entryDecision(
      facts({ noticeServedAt: new Date('2026-08-09T14:00:01Z') }), // one second late
    )
    expect(decision.permitted).toBe(false)
  })

  it('handles a longer statutory period without special-casing', () => {
    expect(
      entryDecision(facts({ entryNoticeHours: 48 })).permitted,
      '24h of notice against a 48h rule',
    ).toBe(false)
    expect(
      entryDecision({
        ...facts({ entryNoticeHours: 48 }),
        noticeServedAt: new Date('2026-08-08T14:00:00Z'),
      }).permitted,
    ).toBe(true)
  })
})

describe('earliestCompliantStart', () => {
  it('adds the required period to when notice goes out', () => {
    const served = new Date('2026-08-09T14:00:00Z')
    expect(earliestCompliantStart(served, 24).toISOString()).toBe('2026-08-10T14:00:00.000Z')
  })

  it('is immediate where no period applies', () => {
    const served = new Date('2026-08-09T14:00:00Z')
    expect(earliestCompliantStart(served, null)).toEqual(served)
  })
})

describe('entryNoticeText', () => {
  const context = {
    tenantName: 'Dana Reyes',
    addressLine1: '14 Magnolia Drive',
    unitName: 'Unit A',
    scheduledStart: new Date('2026-08-10T14:00:00Z'),
    scheduledEnd: new Date('2026-08-10T17:00:00Z'),
    reason: 'Replace the water heater',
    timezone: 'America/Chicago',
    entryNoticeHours: 24,
  }

  it('states the window, the reason, and the statutory period', () => {
    const text = entryNoticeText(context)
    expect(text).toContain('14 Magnolia Drive')
    expect(text).toContain('Replace the water heater')
    expect(text).toContain('24 hours')
    expect(text).toContain('Dana Reyes')
  })

  it('renders the window in the PROPERTY-LOCAL timezone (D-3)', () => {
    // 14:00 UTC is 9am in Chicago. A notice that tells a tenant 2pm when
    // somebody arrives at 9am is worse than no notice.
    const text = entryNoticeText(context)
    expect(text).toContain('9:00')
    expect(text).toContain('August 10, 2026')
  })

  it('ALWAYS says it is a draft and not legal advice', () => {
    // D-4's closing line, and non-negotiable: a generated legal artifact
    // that presents itself as authoritative is worse than none.
    expect(entryNoticeText(context)).toContain('not legal advice')
    expect(entryNoticeText({ ...context, entryNoticeHours: null })).toContain('not legal advice')
  })

  it('adapts its wording where no statutory period applies', () => {
    const text = entryNoticeText({ ...context, entryNoticeHours: null })
    expect(text).not.toContain('requires at least')
    expect(text).toContain('advance notice')
  })
})

describe('validateSchedule', () => {
  const valid = {
    scheduledStart: '2026-08-10T09:00',
    scheduledEnd: '2026-08-10T12:00',
    reason: 'Replace the water heater',
  }

  it('accepts a complete window with a reason', () => {
    expect(validateSchedule(valid)).toEqual([])
  })

  it('requires a reason - a notice with no stated reason is not a notice', () => {
    expect(validateSchedule({ ...valid, reason: '  ' }).map((v) => v.field)).toContain('reason')
  })

  it('requires the window to end after it starts', () => {
    expect(
      validateSchedule({ ...valid, scheduledEnd: '2026-08-10T08:00' }).map((v) => v.field),
    ).toContain('scheduledEnd')
  })

  it('requires both ends of the window', () => {
    expect(validateSchedule({ reason: 'x' }).map((v) => v.field)).toEqual(
      expect.arrayContaining(['scheduledStart', 'scheduledEnd']),
    )
  })
})

describe('validateOverride', () => {
  it('demands a reason', () => {
    expect(validateOverride(null).map((v) => v.field)).toContain('overrideReason')
    expect(validateOverride('   ').map((v) => v.field)).toContain('overrideReason')
  })

  it('accepts a stated one', () => {
    expect(validateOverride('Tenant asked us to come today; no heat')).toEqual([])
  })
})
