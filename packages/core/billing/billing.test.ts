import { describe, expect, it } from 'vitest'
import {
  BILLING_HOUR_LOCAL,
  MAX_BILLING_DAY,
  SIGNATURE_TOLERANCE_SECONDS,
  billingCycleAnchor,
  firstPeriodIsPartial,
  interpretStripeEvent,
  isHandledEvent,
  ledgerAmountCents,
  movesLedger,
  stripeSignatureHeader,
  verifyStripeSignature,
} from './index.ts'

const SECRET = 'whsec_test_not_a_real_key'
const BODY = '{"id":"evt_1","type":"invoice.payment_succeeded"}'
const NOW = 1_800_000_000

describe('verifyStripeSignature', () => {
  function header(overrides: { body?: string; secret?: string; timestamp?: number } = {}) {
    return stripeSignatureHeader({
      rawBody: overrides.body ?? BODY,
      secret: overrides.secret ?? SECRET,
      timestamp: overrides.timestamp ?? NOW,
    })
  }

  it('accepts a genuine signature', () => {
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: header(),
        secret: SECRET,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: true })
  })

  it('REFUSES a body that changed by one byte', () => {
    // The whole point. Everything downstream trusts this endpoint to say
    // money arrived.
    const verdict = verifyStripeSignature({
      rawBody: `${BODY} `,
      header: header(),
      secret: SECRET,
      nowSeconds: NOW,
    })
    expect(verdict).toEqual({ ok: false, reason: 'no_matching_signature' })
  })

  it('refuses a signature made with a different secret', () => {
    const verdict = verifyStripeSignature({
      rawBody: BODY,
      header: header({ secret: 'whsec_someone_elses_key' }),
      secret: SECRET,
      nowSeconds: NOW,
    })
    expect(verdict.ok).toBe(false)
  })

  it('refuses everything when no secret is configured', () => {
    // Defaulting to open would make a missing environment variable in a new
    // deployment into a public money-writing endpoint.
    expect(
      verifyStripeSignature({ rawBody: BODY, header: header(), secret: undefined }),
    ).toEqual({ ok: false, reason: 'no_secret' })
    expect(
      verifyStripeSignature({ rawBody: BODY, header: header(), secret: '' }),
    ).toEqual({ ok: false, reason: 'no_secret' })
  })

  it('refuses a missing or malformed header rather than throwing', () => {
    expect(
      verifyStripeSignature({ rawBody: BODY, header: null, secret: SECRET }).ok,
    ).toBe(false)
    for (const bad of ['', 'garbage', 't=notanumber,v1=abc', 'v1=abc', 't=123']) {
      const verdict = verifyStripeSignature({
        rawBody: BODY,
        header: bad,
        secret: SECRET,
        nowSeconds: NOW,
      })
      expect(verdict.ok, bad).toBe(false)
    }
  })

  it('REFUSES a replayed request once the tolerance window has passed', () => {
    // Without this a captured request stays valid forever, and replaying a
    // payment event would credit a tenant twice.
    const old = header({ timestamp: NOW - SIGNATURE_TOLERANCE_SECONDS - 1 })
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: old,
        secret: SECRET,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' })
  })

  it('accepts one right at the edge of the window', () => {
    const edge = header({ timestamp: NOW - SIGNATURE_TOLERANCE_SECONDS })
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: edge,
        secret: SECRET,
        nowSeconds: NOW,
      }).ok,
    ).toBe(true)
  })

  it('refuses a timestamp from the FUTURE, not just an old one', () => {
    // A clock skew big enough to produce one is itself a reason to distrust
    // the request, and accepting it widens the replay window by however far
    // ahead an attacker claims to be.
    const ahead = header({ timestamp: NOW + SIGNATURE_TOLERANCE_SECONDS + 1 })
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: ahead,
        secret: SECRET,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' })
  })

  it('accepts when ANY v1 matches - which is how a secret is rotated', () => {
    const real = stripeSignatureHeader({ rawBody: BODY, secret: SECRET, timestamp: NOW })
    const other = stripeSignatureHeader({
      rawBody: BODY,
      secret: 'whsec_the_old_one',
      timestamp: NOW,
    })
    const combined = `${other},${real.split(',')[1]}`
    expect(
      verifyStripeSignature({
        rawBody: BODY,
        header: combined,
        secret: SECRET,
        nowSeconds: NOW,
      }).ok,
    ).toBe(true)
  })
})

describe('billingCycleAnchor', () => {
  const CHICAGO = 'America/Chicago'

  it('lands on the due day at the configured local hour', () => {
    const anchor = billingCycleAnchor({
      rentDueDay: 1,
      timezone: CHICAGO,
      notBefore: new Date('2026-03-15T00:00:00Z'),
    })
    // 1 April, 09:00 in Chicago (CDT, UTC-5) = 14:00Z.
    expect(anchor.toISOString()).toBe('2026-04-01T14:00:00.000Z')
  })

  it('does not move the due day to suit an activation date', () => {
    // A lease activated on the 3rd that bills on the 1st anchors to NEXT
    // month's 1st. Quietly moving the due day to the 3rd would change the
    // tenancy's terms.
    const anchor = billingCycleAnchor({
      rentDueDay: 1,
      timezone: CHICAGO,
      notBefore: new Date('2026-03-03T12:00:00Z'),
    })
    expect(anchor.toISOString().slice(0, 10)).toBe('2026-04-01')
  })

  it('uses the same local day when the due day is still ahead this month', () => {
    const anchor = billingCycleAnchor({
      rentDueDay: 20,
      timezone: CHICAGO,
      notBefore: new Date('2026-03-03T12:00:00Z'),
    })
    expect(anchor.toISOString().slice(0, 10)).toBe('2026-03-20')
  })

  it('is a DIFFERENT instant for two properties billing on the same day', () => {
    // The reason this module exists. A server computing either in UTC would
    // be wrong for both.
    const chicago = billingCycleAnchor({
      rentDueDay: 1,
      timezone: CHICAGO,
      notBefore: new Date('2026-06-15T00:00:00Z'),
    })
    const newYork = billingCycleAnchor({
      rentDueDay: 1,
      timezone: 'America/New_York',
      notBefore: new Date('2026-06-15T00:00:00Z'),
    })
    expect(chicago.toISOString()).not.toBe(newYork.toISOString())
    expect(chicago.getTime() - newYork.getTime()).toBe(60 * 60 * 1000)
  })

  it('holds the LOCAL hour across a daylight-saving change', () => {
    // 09:00 local in January and 09:00 local in July are different UTC
    // offsets. Anchoring on a fixed UTC hour instead would silently shift
    // every anchor by an hour twice a year.
    const winter = billingCycleAnchor({
      rentDueDay: 1,
      timezone: CHICAGO,
      notBefore: new Date('2025-12-15T00:00:00Z'),
    })
    const summer = billingCycleAnchor({
      rentDueDay: 1,
      timezone: CHICAGO,
      notBefore: new Date('2026-06-15T00:00:00Z'),
    })
    expect(winter.toISOString()).toContain('T15:00') // CST, UTC-6
    expect(summer.toISOString()).toContain('T14:00') // CDT, UTC-5
  })

  it('handles a notBefore that straddles a month boundary in the property zone', () => {
    // 2026-04-01T02:00Z is still 31 March in Los Angeles - the local
    // calendar month and the UTC one disagree. Either reading converges to
    // the same anchor here, because the loop advances until the candidate
    // clears `notBefore`; what is asserted is the property that actually
    // matters, which is that the answer is the next real billing instant
    // and not something in the past.
    const notBefore = new Date('2026-04-01T02:00:00Z')
    const anchor = billingCycleAnchor({
      rentDueDay: 15,
      timezone: 'America/Los_Angeles',
      notBefore,
    })
    expect(anchor.getTime()).toBeGreaterThanOrEqual(notBefore.getTime())
    expect(anchor.toISOString().slice(0, 10)).toBe('2026-04-15')
  })

  it('never returns an instant before notBefore - Stripe would reject it', () => {
    for (const day of [1, 5, 15, 28]) {
      const notBefore = new Date('2026-05-20T18:00:00Z')
      const anchor = billingCycleAnchor({ rentDueDay: day, timezone: CHICAGO, notBefore })
      expect(anchor.getTime(), `day ${day}`).toBeGreaterThanOrEqual(notBefore.getTime())
    }
  })

  it('rolls the year over from December', () => {
    const anchor = billingCycleAnchor({
      rentDueDay: 1,
      timezone: CHICAGO,
      notBefore: new Date('2026-12-15T00:00:00Z'),
    })
    expect(anchor.toISOString().slice(0, 7)).toBe('2027-01')
  })

  it('refuses a billing day that does not exist in every month', () => {
    for (const day of [0, 29, 30, 31, 1.5]) {
      expect(() =>
        billingCycleAnchor({ rentDueDay: day, timezone: CHICAGO, notBefore: new Date() }),
      ).toThrow(/1 to 28/)
    }
    expect(MAX_BILLING_DAY).toBe(28)
    expect(BILLING_HOUR_LOCAL).toBe(9)
  })
})

describe('firstPeriodIsPartial', () => {
  it('is false when the tenancy starts on its own billing day', () => {
    expect(
      firstPeriodIsPartial({
        startsOn: new Date('2026-03-01T12:00:00Z'),
        rentDueDay: 1,
        timezone: 'America/Chicago',
      }),
    ).toBe(false)
  })

  it('is true for a mid-month move-in', () => {
    // R-042 owns computing the amount - D-12 keeps that ours rather than
    // Stripe's. This only reports that the question exists, so a later item
    // cannot silently skip it.
    expect(
      firstPeriodIsPartial({
        startsOn: new Date('2026-03-12T12:00:00Z'),
        rentDueDay: 1,
        timezone: 'America/Chicago',
      }),
    ).toBe(true)
  })
})

describe('interpretStripeEvent', () => {
  function event(type: string, object: Record<string, unknown>) {
    return { id: 'evt_1', type, created: 1_800_000_000, data: { object } }
  }

  it('projects a successful invoice payment as money in', () => {
    const result = interpretStripeEvent(
      event('invoice.payment_succeeded', {
        id: 'in_123',
        customer: 'cus_123',
        amount_paid: 150_000,
        payment_intent: 'pi_123',
      }),
    )
    expect(result.outcome).toBe('project')
    if (result.outcome !== 'project') return
    expect(result.intent).toMatchObject({
      kind: 'payment_succeeded',
      stripeObjectId: 'in_123',
      stripeCustomerId: 'cus_123',
      stripeInvoiceId: 'in_123',
      stripePaymentIntentId: 'pi_123',
      amountCents: 150_000,
    })
    expect(result.intent.occurredAt.toISOString()).toBe('2027-01-15T08:00:00.000Z')
  })

  it('reads amount_PAID, not the invoice total', () => {
    // A partially-paid invoice reports what actually arrived. Projecting
    // the total would credit money nobody sent.
    const result = interpretStripeEvent(
      event('invoice.payment_succeeded', {
        id: 'in_1',
        customer: 'cus_1',
        total: 200_000,
        amount_paid: 50_000,
      }),
    )
    expect(result.outcome === 'project' && result.intent.amountCents).toBe(50_000)
  })

  it('projects a failed payment WITHOUT moving the balance', () => {
    // Nothing has changed about what is owed - the charge is still owed.
    const result = interpretStripeEvent(
      event('invoice.payment_failed', { id: 'in_2', customer: 'cus_1', amount_due: 150_000 }),
    )
    expect(result.outcome).toBe('project')
    if (result.outcome !== 'project') return
    expect(result.intent.kind).toBe('payment_failed')
    expect(ledgerAmountCents(result.intent)).toBe(0)
    expect(movesLedger(result.intent)).toBe(false)
  })

  it('projects a refund as money going back out', () => {
    const result = interpretStripeEvent(
      event('charge.refunded', {
        id: 'ch_1',
        customer: 'cus_1',
        amount_refunded: 25_000,
        invoice: 'in_1',
      }),
    )
    expect(result.outcome).toBe('project')
    if (result.outcome !== 'project') return
    expect(ledgerAmountCents(result.intent)).toBe(25_000)
  })

  it('gets the SIGNS the right way round', () => {
    // Inverting these would tell somebody they owe rent they already paid.
    const paid = interpretStripeEvent(
      event('invoice.payment_succeeded', { id: 'in_1', customer: 'c', amount_paid: 1000 }),
    )
    const refund = interpretStripeEvent(
      event('charge.refunded', { id: 'ch_1', customer: 'c', amount_refunded: 1000 }),
    )
    expect(paid.outcome === 'project' && ledgerAmountCents(paid.intent)).toBe(-1000)
    expect(refund.outcome === 'project' && ledgerAmountCents(refund.intent)).toBe(1000)
  })

  it('always reports a POSITIVE amount, whatever the event claims', () => {
    // The sign is the projector's decision. An event reporting a negative
    // amount for its own reasons must not be able to flip a credit into a
    // charge.
    const result = interpretStripeEvent(
      event('invoice.payment_succeeded', {
        id: 'in_1',
        customer: 'c',
        amount_paid: -5000,
      }),
    )
    expect(result.outcome).toBe('ignore')
  })

  it('IGNORES an event type nobody has thought about', () => {
    const result = interpretStripeEvent(
      event('customer.subscription.trial_will_end', { id: 'sub_1', customer: 'c' }),
    )
    expect(result.outcome).toBe('ignore')
    expect(isHandledEvent('customer.subscription.trial_will_end')).toBe(false)
  })

  it('does NOT project charge.* alongside invoice.* - that would double-count', () => {
    expect(isHandledEvent('charge.succeeded')).toBe(false)
    expect(isHandledEvent('invoice.payment_succeeded')).toBe(true)
  })

  it('refuses rather than guessing when a piece is missing', () => {
    // A ledger row with an invented amount is worse than no row, because it
    // looks authoritative.
    const noCustomer = interpretStripeEvent(
      event('invoice.payment_succeeded', { id: 'in_1', amount_paid: 1000 }),
    )
    expect(noCustomer).toEqual({
      outcome: 'ignore',
      reason: 'object named no customer',
    })

    const noId = interpretStripeEvent(
      event('invoice.payment_succeeded', { customer: 'c', amount_paid: 1000 }),
    )
    expect(noId.outcome).toBe('ignore')

    const noAmount = interpretStripeEvent(
      event('invoice.payment_succeeded', { id: 'in_1', customer: 'c' }),
    )
    expect(noAmount.outcome).toBe('ignore')
  })

  it('survives a malformed envelope without throwing', () => {
    expect(
      interpretStripeEvent({
        id: 'evt',
        type: 'invoice.payment_succeeded',
        created: 1,
        data: { object: null as never },
      }).outcome,
    ).toBe('ignore')
  })
})
