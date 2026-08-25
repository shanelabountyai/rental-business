import { describe, expect, it } from 'vitest'
import { formatCents } from '../money/index.ts'
import {
  CARD_FIXED_CENTS,
  CARD_RATE_BPS,
  allowsPartialPayment,
  cardFeeDisclosure,
  cardFeeFor,
  debitsAutomatically,
  isCollectionMethod,
  nsfFeeFor,
  offlinePaymentDecision,
  payable,
  returnAction,
  reversalAmountCents,
  railsFor,
  switchDecision,
  validateOfflinePayment,
  validatePaymentAmount,
} from './index.ts'

describe('collection method', () => {
  it('allows a partial payment only on send_invoice', () => {
    // The single behavioural difference OQ-11 was about, and the reason D-29
    // makes the method per payer rather than per product.
    expect(allowsPartialPayment('send_invoice')).toBe(true)
    expect(allowsPartialPayment('charge_automatically')).toBe(false)
  })

  it('reports which mode debits without the payer acting', () => {
    // PAY-02's T-2 pre-debit notice is owed exactly when this is true, and
    // PAY-12's hold is urgent for the same reason.
    expect(debitsAutomatically('charge_automatically')).toBe(true)
    expect(debitsAutomatically('send_invoice')).toBe(false)
  })

  it('refuses a value that is not a collection method', () => {
    expect(isCollectionMethod('charge_automatically')).toBe(true)
    expect(isCollectionMethod('send_invoice')).toBe(true)
    expect(isCollectionMethod('whenever_they_like')).toBe(false)
  })
})

describe('switchDecision', () => {
  const clean = {
    current: 'charge_automatically' as const,
    target: 'send_invoice' as const,
    hasSubscription: true,
    collectionPaused: false,
    payerHasEmail: true,
    paymentsInFlight: 0,
    openInvoiceAmountCents: 0,
  }

  it('allows the switch when nothing is outstanding', () => {
    expect(switchDecision(clean)).toEqual({ allowed: true })
  })

  it('says so when the target is already the current method', () => {
    // Not a refusal. A caller asking for a state that already holds should
    // be told it holds, not told no.
    const decision = switchDecision({ ...clean, target: 'charge_automatically' })
    expect(decision).toEqual({ allowed: false, alreadySet: true })
  })

  it('REFUSES while an invoice is still open — the double-bill this exists to prevent', () => {
    // D-29 named this as R-037's hardest test: switching over an unsettled
    // invoice lets the new mode's subscription bill the same period again.
    const decision = switchDecision({ ...clean, openInvoiceAmountCents: 150_000 })
    expect(decision).toEqual({ allowed: false, refusal: 'open_invoice' })
  })

  it('REFUSES when we have not asked Stripe what is open', () => {
    // Null means "we have not asked", never "nothing owed" - the same rule
    // R-036's lifecycle decision follows. The cost of guessing wrong here is
    // a tenant billed twice for one month's rent.
    const decision = switchDecision({ ...clean, openInvoiceAmountCents: null })
    expect(decision.allowed).toBe(false)
    expect(decision.refusal).toBe('open_invoice')
  })

  it('puts a payment in flight AHEAD of the open invoice it is about to settle', () => {
    // Ordering is the design. The in-flight payment's outcome decides
    // whether the invoice is owed at all, so refusing on the invoice first
    // would send staff chasing a balance that is about to clear itself.
    const decision = switchDecision({
      ...clean,
      paymentsInFlight: 1,
      openInvoiceAmountCents: 150_000,
    })
    expect(decision.refusal).toBe('payment_in_flight')
  })

  it('REFUSES send_invoice for a payer with no email — Stripe will not invoice them', () => {
    // FOUND BY CALLING STRIPE, not by reading its documentation: "Missing
    // email. In order to create invoices that are sent to the customer, the
    // customer must have a valid email." Every unit test asserted we sent
    // the right request; only Stripe could say the customer was not ready to
    // receive it.
    const decision = switchDecision({ ...clean, payerHasEmail: false })
    expect(decision).toEqual({ allowed: false, refusal: 'no_email_for_invoicing' })
  })

  it('does NOT require an email to move back to autopay', () => {
    // Autopay pulls from a saved method and sends nothing, so the constraint
    // is one-directional. A payer moved onto invoicing and then back must
    // not be trapped by a rule that only governs the other direction.
    const back = {
      ...clean,
      current: 'send_invoice' as const,
      target: 'charge_automatically' as const,
      payerHasEmail: false,
    }
    expect(switchDecision(back)).toEqual({ allowed: true })
  })

  it('REFUSES while collection is paused', () => {
    // R-047 pauses precisely so that nothing bills. A switch that resumed
    // billing as a side effect would defeat a legal-action hold.
    const decision = switchDecision({ ...clean, collectionPaused: true })
    expect(decision.refusal).toBe('collection_paused')
  })

  it('REFUSES before there is a subscription to change', () => {
    const decision = switchDecision({ ...clean, hasSubscription: false })
    expect(decision.refusal).toBe('not_provisioned')
  })

  it('switches back the other way under the same rules', () => {
    // The refusals are about the state of the money, not the direction of
    // travel - a payer moving off a payment plan is exactly as exposed to
    // the double-bill as one moving onto it.
    const back = { ...clean, current: 'send_invoice' as const, target: 'charge_automatically' as const }
    expect(switchDecision(back)).toEqual({ allowed: true })
    expect(switchDecision({ ...back, openInvoiceAmountCents: 1 }).refusal).toBe('open_invoice')
  })
})

describe('cardFeeFor', () => {
  const permitted = { cardSurchargePermitted: true, cardSurchargeMaxBps: null }

  it('GROSSES UP so the pass-through actually covers the cost', () => {
    // The arithmetic worth reading twice. A nominal fee (rate x rent + fixed)
    // leaves the owner short, because the processor takes its cut of the
    // total it charges, not of the rent underneath it.
    const decision = cardFeeFor(permitted, 150_000)

    const nominal = Math.round((150_000 * CARD_RATE_BPS) / 10_000) + CARD_FIXED_CENTS
    expect(decision.feeCents).toBeGreaterThan(nominal)

    // And it lands exactly: charging the total, less the processor's cut of
    // the total, leaves the rent whole.
    const processorTakes = Math.floor((decision.totalCents * CARD_RATE_BPS) / 10_000) + CARD_FIXED_CENTS
    expect(decision.totalCents - processorTakes).toBeGreaterThanOrEqual(150_000)
  })

  it('rounds the fee UP, never down', () => {
    // Rounding down loses a fraction every time, and being generous on a fee
    // the tenant chose to incur - ACH is free - is the wrong direction.
    for (const amount of [1, 99, 100, 1_337, 150_000, 249_999]) {
      const decision = cardFeeFor(permitted, amount)
      const processorTakes =
        Math.floor((decision.totalCents * CARD_RATE_BPS) / 10_000) + CARD_FIXED_CENTS
      expect(decision.totalCents - processorTakes, `amount ${amount}`).toBeGreaterThanOrEqual(amount)
    }
  })

  it('charges nothing, and says so, where surcharging is not permitted', () => {
    // D-4: several states restrict this. The owner absorbs the cost and the
    // tenant is shown no fee line at all.
    const decision = cardFeeFor({ cardSurchargePermitted: false, cardSurchargeMaxBps: null }, 150_000)
    expect(decision.feeCents).toBe(0)
    expect(decision.totalCents).toBe(150_000)
    expect(decision.permitted).toBe(false)
    // Still reports what it WOULD have been - the question every fee dispute
    // starts with, and what an owner needs to see what absorbing it costs.
    expect(decision.computedCents).toBeGreaterThan(0)
  })

  it('clamps to a statutory cap and says it clamped', () => {
    // 1% cap against a ~2.99% real cost: the owner absorbs the remainder,
    // and that is a fact worth being able to report on.
    const decision = cardFeeFor({ cardSurchargePermitted: true, cardSurchargeMaxBps: 100 }, 150_000)
    expect(decision.feeCents).toBe(1_500)
    expect(decision.cappedAtCents).toBe(1_500)
    expect(decision.computedCents).toBeGreaterThan(1_500)
    expect(decision.totalCents).toBe(151_500)
  })

  it('leaves a generous cap alone', () => {
    const capped = cardFeeFor({ cardSurchargePermitted: true, cardSurchargeMaxBps: 500 }, 150_000)
    const uncapped = cardFeeFor(permitted, 150_000)
    expect(capped.feeCents).toBe(uncapped.feeCents)
    expect(capped.cappedAtCents).toBeUndefined()
  })

  it('handles a zero or negative amount without inventing a fee', () => {
    // A credit balance is a real state - the tenant owes nothing - and it
    // must not produce a fee to pay it.
    expect(cardFeeFor(permitted, 0).feeCents).toBe(0)
    expect(cardFeeFor(permitted, -5_000).feeCents).toBe(0)
  })

  it('returns whole cents for every amount it is given', () => {
    for (const amount of [1, 7, 33, 1_000, 99_999, 1_000_000]) {
      const decision = cardFeeFor(permitted, amount)
      expect(Number.isInteger(decision.feeCents), `amount ${amount}`).toBe(true)
      expect(Number.isInteger(decision.totalCents), `amount ${amount}`).toBe(true)
    }
  })
})

describe('cardFeeDisclosure', () => {
  it('states the fee in money, and names the free alternative', () => {
    // PAY-01 requires disclosure BEFORE the choice. A percentage is a
    // calculation a tenant should not do while holding a phone.
    const decision = cardFeeFor({ cardSurchargePermitted: true, cardSurchargeMaxBps: null }, 150_000)
    const text = cardFeeDisclosure(decision, formatCents)!
    expect(text).toContain(formatCents(decision.feeCents))
    expect(text).toContain(formatCents(decision.totalCents))
    expect(text).toContain('free')
  })

  it('says nothing at all when there is no fee', () => {
    // Not "a fee of $0.00" - a line that always renders is a line tenants
    // learn to skip, which defeats the disclosure on the months it matters.
    const decision = cardFeeFor({ cardSurchargePermitted: false, cardSurchargeMaxBps: null }, 150_000)
    expect(cardFeeDisclosure(decision, formatCents)).toBeNull()
  })
})

describe('railsFor', () => {
  it('offers ACH first, because it is the free one', () => {
    // Ordering is not cosmetic: a screen that leads with the card quietly
    // costs tenants money they did not have to spend.
    const rails = railsFor({ method: 'send_invoice', cardPermitted: true, retailCashConfigured: true })
    expect(rails[0]!.rail).toBe('ACH')
    expect(rails.every((r) => r.available)).toBe(true)
  })

  it('explains an unavailable rail instead of hiding it silently', () => {
    const rails = railsFor({
      method: 'send_invoice',
      cardPermitted: false,
      retailCashConfigured: false,
    })
    const card = rails.find((r) => r.rail === 'CARD')!
    const cash = rails.find((r) => r.rail === 'RETAIL_CASH')!
    expect(card.available).toBe(false)
    expect(card.unavailableReason).toContain('free')
    expect(cash.available).toBe(false)
  })

  it('always offers ACH, on either collection method', () => {
    // A tenant on autopay can still want to pay early or pay off a balance.
    for (const method of ['charge_automatically', 'send_invoice'] as const) {
      const rails = railsFor({ method, cardPermitted: true, retailCashConfigured: false })
      expect(rails.find((r) => r.rail === 'ACH')!.available, method).toBe(true)
    }
  })
})


describe('payable / validatePaymentAmount', () => {
  const invoiced = { method: 'send_invoice' as const, balanceCents: 150_000, inFlightCents: 0 }

  it('SUBTRACTS money already on its way', () => {
    // The ledger deliberately does not move for an in-flight ACH debit, and
    // rightly so. But a screen that ignored it would show the full balance
    // to a tenant who paid three days ago and invite a second debit.
    const limits = payable({ ...invoiced, inFlightCents: 150_000 })
    expect(limits.maxCents).toBe(0)
    expect(limits.inFlightCents).toBe(150_000)
  })

  it('refuses a second payment when everything owed is already in flight', () => {
    const result = validatePaymentAmount({ ...invoiced, inFlightCents: 150_000 }, 150_000)
    expect(result).toEqual({ ok: false, refusal: 'already_covered' })
  })

  it('lets an invoiced payer pay part of it', () => {
    expect(validatePaymentAmount(invoiced, 50_000)).toEqual({ ok: true })
  })

  it('REFUSES a partial payment on autopay — the whole of OQ-11', () => {
    // Stripe cannot take it on a `charge_automatically` subscription, and
    // enforcing it here means a hand-crafted request cannot land us with a
    // partial payment Stripe will not reconcile.
    const autopay = { ...invoiced, method: 'charge_automatically' as const }
    expect(validatePaymentAmount(autopay, 50_000)).toEqual({
      ok: false,
      refusal: 'partial_not_allowed',
    })
    // The full amount is still fine on either mode.
    expect(validatePaymentAmount(autopay, 150_000)).toEqual({ ok: true })
  })

  it('refuses an overpayment rather than accepting money it cannot place', () => {
    // A credit balance has to be allocated somewhere, and the allocation
    // order is jurisdiction configuration (R-035). Taking money this flow
    // cannot correctly place is worse than declining it.
    expect(validatePaymentAmount(invoiced, 200_000).ok).toBe(false)
  })

  it('says there is nothing to pay when the balance is clear', () => {
    expect(validatePaymentAmount({ ...invoiced, balanceCents: 0 }, 1)).toEqual({
      ok: false,
      refusal: 'nothing_owed',
    })
    // A credit balance is a real state, and is not an invitation to pay.
    expect(validatePaymentAmount({ ...invoiced, balanceCents: -5_000 }, 1).ok).toBe(false)
  })

  it('refuses zero, negative and fractional amounts', () => {
    for (const amount of [0, -1, 12.5]) {
      expect(validatePaymentAmount(invoiced, amount).ok, String(amount)).toBe(false)
    }
  })

  it('lets an autopay payer clear what is LEFT after money in flight', () => {
    // The full-amount rule is against `maxCents`, not against the raw
    // balance - otherwise a tenant with a partial ACH in flight could never
    // pay the remainder, which is exactly when they most want to.
    const autopay = {
      method: 'charge_automatically' as const,
      balanceCents: 150_000,
      inFlightCents: 100_000,
    }
    expect(validatePaymentAmount(autopay, 50_000)).toEqual({ ok: true })
  })
})

describe('offline payments (PAY-05)', () => {
  const good = {
    channel: 'OFFLINE_CHECK',
    amountCents: 150_000,
    receivedOn: '2026-08-10',
    checkNumber: '1041',
    receivedByStaffId: 'staff_1',
  }
  const today = '2026-08-10'

  it('accepts a well-formed check', () => {
    expect(validateOfflinePayment(good, today)).toEqual([])
  })

  it('REQUIRES a check number on a check', () => {
    // The number is how a returned check is matched back to the record
    // months later.
    const violations = validateOfflinePayment({ ...good, checkNumber: null }, today)
    expect(violations.map((v) => v.field)).toContain('checkNumber')
    // Cash needs none.
    expect(
      validateOfflinePayment({ ...good, channel: 'OFFLINE_CASH', checkNumber: null }, today),
    ).toEqual([])
  })

  it('REFUSES an unattributed payment', () => {
    // PAY-05: a cash payment with no named recipient is an unauditable cash
    // payment. It comes from the session, so a violation means a caller
    // forgot - which must fail loudly rather than write the row.
    const violations = validateOfflinePayment({ ...good, receivedByStaffId: null }, today)
    expect(violations.map((v) => v.field)).toContain('receivedByStaffId')
  })

  it('refuses a future date, because a post-dated check is not money yet', () => {
    const violations = validateOfflinePayment({ ...good, receivedOn: '2026-08-11' }, today)
    expect(violations.map((v) => v.field)).toContain('receivedOn')
    // Backdating IS allowed: a check handed over Friday and typed in Monday
    // was paid on Friday, and late-fee arithmetic runs off the real date.
    expect(validateOfflinePayment({ ...good, receivedOn: '2026-08-07' }, today)).toEqual([])
  })

  it('refuses a rail that is not somebody at a counter', () => {
    // RETAIL_CASH is a third-party network posting electronically (R-037a),
    // not a person handing over notes.
    for (const channel of ['RETAIL_CASH', 'ACH', 'CARD']) {
      const violations = validateOfflinePayment({ ...good, channel, checkNumber: null }, today)
      expect(violations.map((v) => v.field), channel).toContain('channel')
    }
  })

  it('refuses zero, negative and fractional amounts', () => {
    for (const amountCents of [0, -1, 12.5]) {
      const violations = validateOfflinePayment({ ...good, amountCents }, today)
      expect(violations.map((v) => v.field), String(amountCents)).toContain('amountDollars')
    }
  })
})

describe('offlinePaymentDecision', () => {
  const owing = { balanceCents: 150_000, openInvoiceAmountCents: 150_000, blockPartial: false }

  it('applies a payment that settles the open invoice', () => {
    expect(offlinePaymentDecision(owing, 150_000)).toEqual({ allowed: true })
  })

  it('names "nothing owed" before "too much", for the wrong-tenant case', () => {
    // A staff member typing into the wrong lease needs to hear the first
    // one, not be told their arithmetic is off.
    expect(offlinePaymentDecision({ ...owing, balanceCents: 0 }, 150_000)).toEqual({
      allowed: false,
      refusal: 'nothing_owed',
    })
  })

  it('refuses more than is owed', () => {
    expect(offlinePaymentDecision(owing, 200_000).refusal).toBe('more_than_owed')
  })

  it('ALLOWS a part-payment, which R-038 refused', () => {
    // Somebody arriving at the counter with half the rent in cash is a real
    // situation, and R-038 could only turn them away: its `paid_out_of_band`
    // call settled the WHOLE invoice whatever arrived, so applying half
    // would have written the other half off silently. R-038a attaches a
    // PaymentRecord instead, which leaves the invoice open for the rest -
    // measured against the real API, not assumed.
    expect(offlinePaymentDecision(owing, 50_000)).toEqual({ allowed: true })
  })

  it('refuses MORE than the invoice in front of us still asks for', () => {
    // Under the balance (so not `more_than_owed`) and over the open invoice.
    // Stripe itself refuses to attach a payment larger than the remainder,
    // and the surplus belongs to a period nobody has billed yet.
    expect(
      offlinePaymentDecision(
        { balanceCents: 200_000, openInvoiceAmountCents: 150_000, blockPartial: false },
        175_000,
      ).refusal,
    ).toBe('more_than_invoiced')
  })

  it('refuses a part-payment on a tenancy the operator has held (PAY-12)', () => {
    // R-038 could not take a part-payment at all, so this switch was
    // satisfied by accident. Making them possible at the counter without
    // this check would reopen the hazard it exists for: in many states
    // accepting a partial after serving notice can void the eviction.
    const held = { ...owing, blockPartial: true }
    expect(offlinePaymentDecision(held, 50_000).refusal).toBe('partial_blocked')
    // The full balance is still recordable - the switch is "all or nothing",
    // not "nothing".
    expect(offlinePaymentDecision(held, 150_000)).toEqual({ allowed: true })
  })

  it('names the arithmetic problem before the policy one', () => {
    // A staff member in the wrong tenant's record needs to hear that first;
    // being told about a legal hold on a lease they did not mean to open is
    // both unhelpful and a disclosure.
    expect(
      offlinePaymentDecision({ ...owing, blockPartial: true, balanceCents: 0 }, 50_000).refusal,
    ).toBe('nothing_owed')
  })

  it('refuses when there is no issued invoice to mark', () => {
    expect(
      offlinePaymentDecision(
        { balanceCents: 150_000, openInvoiceAmountCents: 0, blockPartial: false },
        150_000,
      ).refusal,
    ).toBe('no_open_invoice')
  })

  it('refuses when we could not ask what is open', () => {
    // Null means "we have not asked", never "nothing owed" - the same rule
    // the collection-method switch follows.
    expect(
      offlinePaymentDecision(
        { balanceCents: 150_000, openInvoiceAmountCents: null, blockPartial: false },
        150_000,
      ).refusal,
    ).toBe('no_open_invoice')
  })
})

describe('returnAction (PAY-02)', () => {
  it('REVERSES a payment that had already settled', () => {
    // The bug this exists to fix: an ACH debit that settled, moved the
    // ledger, and came back four days later. Without a reversal the credit
    // stays and the tenant appears to have paid.
    expect(returnAction('SETTLED')).toBe('reverse')
  })

  it('merely records a first attempt that never succeeded', () => {
    // Nothing was credited, so there is nothing to take back. The same
    // Stripe event means two different things depending on history, which is
    // the whole subtlety.
    expect(returnAction(null)).toBe('record_failure')
    expect(returnAction('PENDING')).toBe('record_failure')
    expect(returnAction('FAILED')).toBe('record_failure')
  })

  it('IGNORES a second delivery of the same return', () => {
    // Stripe promises neither ordering nor exactly-once delivery, and
    // reversing twice would double the balance owed.
    expect(returnAction('REVERSED')).toBe('ignore')
    expect(returnAction('REFUNDED')).toBe('ignore')
  })
})

describe("the owner's require-full-balance switch (R-039a, D-29)", () => {
  const invoiced = { method: 'send_invoice' as const, balanceCents: 150_000, inFlightCents: 0 }

  it('normally lets an invoiced payer pay part of it (D-29)', () => {
    expect(payable(invoiced).allowsPartial).toBe(true)
    expect(validatePaymentAmount(invoiced, 50_000)).toEqual({ ok: true })
  })

  it('REFUSES a part payment when the owner requires the full balance', () => {
    // The case it exists for: a tenant on invoicing because they have no
    // card, whose payment plan already failed once.
    const strict = { ...invoiced, requireFullBalance: true }
    expect(payable(strict).allowsPartial).toBe(false)
    expect(validatePaymentAmount(strict, 50_000)).toEqual({
      ok: false,
      refusal: 'partial_not_allowed',
    })
  })

  it('still takes the FULL amount from that payer', () => {
    // The switch refuses partials, not payment.
    const strict = { ...invoiced, requireFullBalance: true }
    expect(validatePaymentAmount(strict, 150_000)).toEqual({ ok: true })
  })

  it('changes nothing for a payer who could not pay partially anyway', () => {
    // `charge_automatically` cannot take a partial payment at all - Stripe
    // will not reconcile one - so the owner switch is a no-op there rather
    // than a second rule that could disagree with the first.
    const auto = { method: 'charge_automatically' as const, balanceCents: 150_000, inFlightCents: 0 }
    expect(payable(auto).allowsPartial).toBe(false)
    expect(payable({ ...auto, requireFullBalance: true }).allowsPartial).toBe(false)
  })

  it('is OFF when nobody set it, so every existing payer behaves as before', () => {
    expect(payable(invoiced).allowsPartial).toBe(true)
  })
})

describe('nsfFeeFor (PAY-02, D-4, D-12)', () => {
  const texas = { nsfFeePermitted: true, nsfFeeMaxCents: 3_000 }

  it('charges what the lease provides for, under the cap', () => {
    expect(nsfFeeFor(texas, 2_500)).toMatchObject({ amountCents: 2_500, permitted: true })
  })

  it('CLAMPS to the statutory ceiling and says it clamped', () => {
    const decision = nsfFeeFor(texas, 5_000)
    expect(decision.amountCents).toBe(3_000)
    expect(decision.cappedAtCents).toBe(3_000)
    expect(decision.computedCents).toBe(5_000)
  })

  it('charges nothing where the state bars the fee', () => {
    const decision = nsfFeeFor({ nsfFeePermitted: false, nsfFeeMaxCents: null }, 3_000)
    expect(decision.amountCents).toBe(0)
    expect(decision.permitted).toBe(false)
    // Still reports what it would have been - what absorbing it costs.
    expect(decision.computedCents).toBe(3_000)
  })

  it('charges nothing when the LEASE is silent, even where the state allows it', () => {
    // The fee is a contractual term first and a statutory ceiling second.
    // Inventing one the tenant never agreed to is how a fee becomes
    // unenforceable at the moment somebody needs to enforce it.
    expect(nsfFeeFor(texas, null).amountCents).toBe(0)
    expect(nsfFeeFor(texas, 0).amountCents).toBe(0)
  })

  it('never returns a negative fee', () => {
    expect(nsfFeeFor(texas, -5_000).amountCents).toBe(0)
  })
})

describe('reversalAmountCents', () => {
  it('gives back exactly what was given, whichever sign it is handed', () => {
    // A partial payment that returns must give back what it gave - an
    // invoice total is not that number. The direction is this function's
    // decision, not its caller's.
    expect(reversalAmountCents(-50_000)).toBe(50_000)
    expect(reversalAmountCents(50_000)).toBe(50_000)
  })
})
