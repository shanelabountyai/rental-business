import { describe, expect, it } from 'vitest'
import {
  ACCESS_MARGIN_MINUTES,
  SELF_SHOWING_REFUSAL_MESSAGES,
  type SelfShowingInput,
  accessWindow,
  canIssueSelfShowingCode,
  namesAgree,
  selfShowingDecision,
} from './self-showing.ts'

// Unaccompanied entry for a self-showing (LEASE-08, R-094).

const START = new Date('2026-09-01T15:00:00Z')
const END = new Date('2026-09-01T15:30:00Z')

const base: SelfShowingInput = {
  now: new Date('2026-09-01T15:05:00Z'),
  unitStatus: 'VACANT',
  hasActiveSmartLock: true,
  showingStatus: 'BOOKED',
  scheduledStart: START,
  scheduledEnd: END,
  identity: { result: 'VERIFIED', namesAgree: true },
  revokedAt: null,
}

describe('the access window', () => {
  it('opens a margin before the slot and closes a margin after it', () => {
    expect(accessWindow({ scheduledStart: START, scheduledEnd: END })).toEqual({
      validFrom: new Date('2026-09-01T14:45:00Z'),
      validTo: new Date('2026-09-01T15:45:00Z'),
    })
    // Small on purpose: every extra minute is unaccompanied time in an empty
    // home that nobody scheduled.
    expect(ACCESS_MARGIN_MINUTES).toBeLessThanOrEqual(30)
  })

  it('lets somebody in during the margin and not a minute before it', () => {
    expect(selfShowingDecision({ ...base, now: new Date('2026-09-01T14:45:00Z') }).refusal)
      .toBeUndefined()
    expect(selfShowingDecision({ ...base, now: new Date('2026-09-01T14:44:59Z') }).refusal)
      .toBe('too_early')
    expect(selfShowingDecision({ ...base, now: new Date('2026-09-01T15:45:00Z') }).refusal)
      .toBeUndefined()
    expect(selfShowingDecision({ ...base, now: new Date('2026-09-01T15:45:01Z') }).refusal)
      .toBe('expired')
  })
})

describe('the name comparison', () => {
  it('forgives everything except a different person', () => {
    // Case, accents, punctuation, doubled spaces and middle names all differ
    // routinely between a booking form and a driving licence.
    expect(namesAgree('ada lovelace', 'Ada Lovelace')).toBe(true)
    expect(namesAgree('Ada Lovelace', 'Ada  B.  Lovelace')).toBe(true)
    expect(namesAgree('José García', 'Jose Garcia')).toBe(true)
    expect(namesAgree("Ada O'Brien", 'Ada OBrien')).toBe(true)
  })

  it('refuses a double-barrelled surname written two ways, on purpose', () => {
    // Knowingly imperfect, and imperfect in the SAFE direction: it sends
    // somebody to a phone call rather than opening a door. The refusal
    // message says the office can sort it in a minute.
    expect(namesAgree('Ada Smith-Jones', 'Ada Smith Jones')).toBe(false)
  })

  it('refuses a different first or last name', () => {
    // A genuine licence belonging to somebody else is the case this whole
    // feature exists to catch.
    expect(namesAgree('Ada Lovelace', 'Bob Lovelace')).toBe(false)
    expect(namesAgree('Ada Lovelace', 'Ada Babbage')).toBe(false)
    expect(namesAgree('Ada Lovelace', '')).toBe(false)
  })
})

describe('whether the code may be shown', () => {
  it('refuses an occupied unit before anything else', () => {
    // An unaccompanied code on an occupied home is a stranger with a key to
    // somebody's house, and it outranks every other reason to refuse.
    const decision = selfShowingDecision({
      ...base,
      unitStatus: 'OCCUPIED',
      identity: null,
      revokedAt: new Date(),
    })
    expect(decision.refusal).toBe('unit_occupied')
    expect(SELF_SHOWING_REFUSAL_MESSAGES.unit_occupied).toContain('do not go in')
  })

  it('refuses a unit with no lock, which is how the feature stays opt-in', () => {
    expect(selfShowingDecision({ ...base, hasActiveSmartLock: false }).refusal).toBe(
      'no_smart_lock',
    )
  })

  it('puts a killed code ahead of "not yet"', () => {
    // Somebody whose code was pulled because the house was let this morning
    // must be told that, not told to come back in ten minutes.
    const decision = selfShowingDecision({
      ...base,
      now: new Date('2026-09-01T09:00:00Z'),
      revokedAt: new Date('2026-09-01T08:00:00Z'),
    })
    expect(decision.refusal).toBe('revoked')
    expect(SELF_SHOWING_REFUSAL_MESSAGES.revoked).toContain('do not try to get in')
  })

  it('separates "we could not read it" from "that was somebody else"', () => {
    expect(selfShowingDecision({ ...base, identity: null }).refusal).toBe('not_verified')
    expect(
      selfShowingDecision({ ...base, identity: { result: 'FAILED', namesAgree: true } }).refusal,
    ).toBe('not_verified')
    expect(
      selfShowingDecision({ ...base, identity: { result: 'NAME_MISMATCH', namesAgree: false } })
        .refusal,
    ).toBe('identity_mismatch')
    // A provider saying "genuine document" while the name disagrees is the
    // dangerous combination, and it must not read as verified.
    expect(
      selfShowingDecision({ ...base, identity: { result: 'VERIFIED', namesAgree: false } }).refusal,
    ).toBe('identity_mismatch')
  })

  it('refuses a cancelled showing', () => {
    expect(selfShowingDecision({ ...base, showingStatus: 'CANCELED' }).refusal).toBe(
      'showing_canceled',
    )
  })

  it('tells the prospect what to do next in every refusal', () => {
    // There is nobody standing there to ask.
    for (const message of Object.values(SELF_SHOWING_REFUSAL_MESSAGES)) {
      expect(message.length).toBeGreaterThan(40)
      expect(message).toMatch(/call the office|book another|come back|confirm who you are|member of staff/i)
    }
  })
})

describe('whether the code may be issued at all', () => {
  it('is the same decision, so the two can never drift apart', () => {
    // An issue-time check that drifted from the reveal-time one is how a code
    // gets minted for a house that was let this morning.
    const input = {
      unitStatus: 'OCCUPIED',
      hasActiveSmartLock: true,
      showingStatus: 'BOOKED',
      scheduledStart: START,
      scheduledEnd: END,
      identity: { result: 'VERIFIED' as const, namesAgree: true },
    }
    expect(canIssueSelfShowingCode(input).refusal).toBe('unit_occupied')
  })

  it('does not refuse a slot that has not started yet', () => {
    // The one thing issue must not inherit from reveal: every code is issued
    // before its window opens.
    expect(
      canIssueSelfShowingCode({
        unitStatus: 'VACANT',
        hasActiveSmartLock: true,
        showingStatus: 'BOOKED',
        scheduledStart: START,
        scheduledEnd: END,
        identity: { result: 'VERIFIED', namesAgree: true },
      }).window,
    ).toEqual(accessWindow({ scheduledStart: START, scheduledEnd: END }))
  })
})
