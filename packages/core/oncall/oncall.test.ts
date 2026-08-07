import { describe, expect, it } from 'vitest'
import {
  ESCALATE_AFTER_MINUTES,
  isOnCall,
  minutesUnacknowledged,
  pagingPlan,
  shouldEscalate,
} from './index.ts'

const NOW = new Date('2026-08-06T03:00:00Z')

function staff(
  email: string,
  window?: { from: string; until: string },
) {
  return {
    id: email,
    email,
    phone: '+15125550100',
    onCallFrom: window ? new Date(window.from) : null,
    onCallUntil: window ? new Date(window.until) : null,
  }
}

const TONIGHT = { from: '2026-08-06T00:00:00Z', until: '2026-08-06T12:00:00Z' }
const LAST_WEEK = { from: '2026-07-30T00:00:00Z', until: '2026-07-30T12:00:00Z' }

describe('isOnCall', () => {
  it('is true inside the window', () => {
    expect(isOnCall(staff('a@x.com', TONIGHT), NOW)).toBe(true)
  })

  it('is false once the window has lapsed', () => {
    expect(isOnCall(staff('a@x.com', LAST_WEEK), NOW)).toBe(false)
  })

  it('is false with no window at all', () => {
    expect(isOnCall(staff('a@x.com'), NOW)).toBe(false)
  })

  it('REFUSES a half-configured window rather than reading it as forever', () => {
    // A start with no end is ambiguous, and "on call until further notice" is
    // how somebody gets paged at 3am for a month after covering one weekend.
    const half = { ...staff('a@x.com'), onCallFrom: new Date('2026-08-01T00:00:00Z') }
    expect(isOnCall(half, NOW)).toBe(false)
  })

  it('includes both endpoints', () => {
    const person = staff('a@x.com', TONIGHT)
    expect(isOnCall(person, new Date(TONIGHT.from))).toBe(true)
    expect(isOnCall(person, new Date(TONIGHT.until))).toBe(true)
  })
})

describe('pagingPlan', () => {
  it('pages ONLY whoever is on call, and lines the rest up behind them', () => {
    const onCall = staff('oncall@x.com', TONIGHT)
    const others = [staff('bob@x.com'), staff('ann@x.com')]
    const plan = pagingPlan([...others, onCall], NOW)

    expect(plan.basis).toBe('on_call_rota')
    expect(plan.recipients.map((r) => r.email)).toEqual(['oncall@x.com'])
    expect(plan.escalationChain.map((r) => r.email)).toEqual([
      'ann@x.com',
      'bob@x.com',
    ])
  })

  it('pages EVERYBODY when nobody is on call', () => {
    // The safety fallback, and the whole reason this function is not simply
    // "the on-call list". A 3am gas leak reaching nobody because the rota
    // lapsed is the one outcome this may never produce.
    const plan = pagingPlan([staff('bob@x.com'), staff('ann@x.com')], NOW)

    expect(plan.basis).toBe('no_rota_paging_everyone')
    expect(plan.recipients.map((r) => r.email)).toEqual(['ann@x.com', 'bob@x.com'])
    expect(plan.escalationChain).toEqual([])
  })

  it('pages everybody when the rota LAPSED, not just when it was never set', () => {
    const plan = pagingPlan([staff('stale@x.com', LAST_WEEK)], NOW)
    expect(plan.basis).toBe('no_rota_paging_everyone')
    expect(plan.recipients).toHaveLength(1)
  })

  it('pages every on-call person, not just the first', () => {
    const plan = pagingPlan(
      [staff('a@x.com', TONIGHT), staff('b@x.com', TONIGHT), staff('c@x.com')],
      NOW,
    )
    expect(plan.recipients.map((r) => r.email)).toEqual(['a@x.com', 'b@x.com'])
  })

  it('pages nobody only when there is nobody at all', () => {
    expect(pagingPlan([], NOW).recipients).toEqual([])
  })
})

describe('shouldEscalate', () => {
  const created = new Date('2026-08-06T03:00:00Z')

  it('holds off before the deadline', () => {
    const at14 = new Date(created.getTime() + 14 * 60_000)
    expect(shouldEscalate({ createdAt: created, acknowledgedAt: null }, at14)).toBe(
      false,
    )
  })

  it('fires exactly at the deadline', () => {
    const at15 = new Date(created.getTime() + ESCALATE_AFTER_MINUTES * 60_000)
    expect(shouldEscalate({ createdAt: created, acknowledgedAt: null }, at15)).toBe(
      true,
    )
  })

  it('NEVER fires once somebody has acknowledged', () => {
    // The whole point of the acknowledge button. Somebody already driving to
    // the property must not cause the owner to be woken up as well.
    const at60 = new Date(created.getTime() + 60 * 60_000)
    expect(
      shouldEscalate({ createdAt: created, acknowledgedAt: new Date() }, at60),
    ).toBe(false)
  })
})

describe('minutesUnacknowledged', () => {
  it('floors, so a message never overstates how long somebody waited', () => {
    const created = new Date('2026-08-06T03:00:00Z')
    const later = new Date('2026-08-06T03:15:59Z')
    expect(minutesUnacknowledged({ createdAt: created }, later)).toBe(15)
  })
})
