import { describe, expect, it } from 'vitest'
import {
  NO_HOLD,
  holdIsActive,
  holdMessage,
  holdRefusal,
} from './legal-hold.ts'
import type { HoldRefusal, PaymentHold } from './legal-hold.ts'

// Payment controls for a tenancy in legal action (PAY-12, R-047).
//
// These are not preferences. In many states accepting a partial payment
// after serving notice VOIDS the notice, so a payment that slips through
// here restarts a legal process — which is why the tests are about what is
// refused, and about what the tenant is told while it is refused.

const hold = (over: Partial<PaymentHold> = {}): PaymentHold => ({ ...NO_HOLD, ...over })

describe('holdIsActive', () => {
  it('is false when nothing is switched on', () => {
    // A hold with no switches is not a hold. The difference decides whether
    // a reason is demanded and whether the tenancy reads as held.
    expect(holdIsActive(NO_HOLD)).toBe(false)
  })

  it('is true if ANY switch is on', () => {
    expect(holdIsActive(hold({ blockOnline: true }))).toBe(true)
    expect(holdIsActive(hold({ blockPartial: true }))).toBe(true)
    expect(holdIsActive(hold({ certifiedFundsOnly: true }))).toBe(true)
  })
})

describe('holdRefusal', () => {
  it('permits a full payment with no hold', () => {
    expect(holdRefusal(NO_HOLD, 150_000, 150_000)).toBeNull()
  })

  it('permits a PART payment with no hold', () => {
    expect(holdRefusal(NO_HOLD, 50_000, 150_000)).toBeNull()
  })

  it('refuses everything when online is blocked, including the full balance', () => {
    expect(holdRefusal(hold({ blockOnline: true }), 150_000, 150_000)).toBe('online_blocked')
  })

  it('refuses everything under certified-funds-only', () => {
    expect(holdRefusal(hold({ certifiedFundsOnly: true }), 150_000, 150_000)).toBe(
      'certified_funds_only',
    )
  })

  describe('blockPartial — the switch the voided-notice problem is about', () => {
    it('REFUSES LESS THAN THE FULL BALANCE', () => {
      // $50 against $1,500 after notice is the act that can restart an
      // eviction in many states.
      expect(holdRefusal(hold({ blockPartial: true }), 50_000, 150_000)).toBe('partial_blocked')
    })

    it('permits exactly the full balance', () => {
      expect(holdRefusal(hold({ blockPartial: true }), 150_000, 150_000)).toBeNull()
    })

    it('compares against what is owed NOW, not a number the screen carried', () => {
      // `owedCents` is `payable()`'s maxCents, already net of money in
      // flight. A page rendered before a late fee posted would otherwise
      // let a now-partial payment through as "full".
      expect(holdRefusal(hold({ blockPartial: true }), 150_000, 155_000)).toBe('partial_blocked')
    })
  })

  describe('ordering, when more than one switch is on', () => {
    it('reports the MOST closing refusal first', () => {
      // A tenant told "we cannot take a part payment" would reasonably try
      // the full amount — and on a blocked tenancy that is a second refusal
      // they should never have been invited into.
      const both = hold({ blockOnline: true, blockPartial: true })
      expect(holdRefusal(both, 50_000, 150_000)).toBe('online_blocked')

      const certifiedAndPartial = hold({ certifiedFundsOnly: true, blockPartial: true })
      expect(holdRefusal(certifiedAndPartial, 50_000, 150_000)).toBe('certified_funds_only')
    })
  })
})

describe('holdMessage — PAY-12 requires it to be NEUTRAL', () => {
  const refusals: HoldRefusal[] = ['online_blocked', 'certified_funds_only', 'partial_blocked']

  it('NEVER MENTIONS EVICTION, NOTICE, LEGAL ACTION OR A COURT', () => {
    // Two reasons, and both matter. A payment screen is not lawful service
    // of a notice, so it must not pre-empt the instrument that is. And the
    // screen may be read by somebody who is not the tenant — a phone gets
    // handed around — so announcing a legal action discloses it to whoever
    // is holding the device.
    for (const refusal of refusals) {
      const message = holdMessage(refusal)
      expect(message, refusal).not.toMatch(
        /evict|eviction|notice|legal|court|attorney|lawyer|proceeding|case/i,
      )
    }
  })

  it('points at a person in every branch', () => {
    // A refusal somebody cannot act on gets worked around, or becomes a
    // phone call to the wrong number.
    for (const refusal of refusals) {
      expect(holdMessage(refusal), refusal).toMatch(/contact the office/i)
    }
  })

  it('says what is actually accepted under certified-funds-only', () => {
    // "Not available" alone would send somebody to the portal again. This
    // one has a real alternative, so it names it.
    expect(holdMessage('certified_funds_only')).toMatch(/cashier|money order/i)
  })

  it('gives each refusal its own wording', () => {
    // Three different situations with one message teaches a tenant that the
    // message means nothing.
    expect(new Set(refusals.map(holdMessage)).size).toBe(refusals.length)
  })
})
