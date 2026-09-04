import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOCATION_ORDER,
  allocatePayment,
  allocationOrderFor,
  balanceCents,
  detectDrift,
  detectLeaseBalanceDrift,
  reversedEntryIds,
  statement,
} from './index.ts'

describe('allocatePayment', () => {
  const charges = [
    { id: 'fee', type: 'LATE_FEE', outstandingCents: 5_000, dueOn: '2026-08-06' },
    { id: 'rent', type: 'RENT', outstandingCents: 150_000, dueOn: '2026-08-01' },
    { id: 'nsf', type: 'NSF_FEE', outstandingCents: 3_500, dueOn: '2026-08-04' },
  ]

  it('follows the jurisdiction’s order, not the order it was handed', () => {
    // The whole point. Applying a partial payment to fees before rent leaves
    // rent unpaid, which is what a pay-or-quit notice is served on.
    const result = allocatePayment(150_000, charges, ['RENT', 'LATE_FEE', 'NSF_FEE'])
    expect(result.applications).toEqual([{ chargeId: 'rent', appliedCents: 150_000 }])
    expect(result.unappliedCents).toBe(0)
  })

  it('honours a jurisdiction that puts FEES first', () => {
    // Some states legislate the opposite. The module applies whatever order
    // it is handed - it does not have an opinion.
    const result = allocatePayment(10_000, charges, ['LATE_FEE', 'NSF_FEE', 'RENT'])
    expect(result.applications).toEqual([
      { chargeId: 'fee', appliedCents: 5_000 },
      { chargeId: 'nsf', appliedCents: 3_500 },
      { chargeId: 'rent', appliedCents: 1_500 },
    ])
  })

  it('spills over into the next charge when one is settled', () => {
    const result = allocatePayment(7_000, charges, ['LATE_FEE', 'NSF_FEE', 'RENT'])
    expect(result.applications).toEqual([
      { chargeId: 'fee', appliedCents: 5_000 },
      { chargeId: 'nsf', appliedCents: 2_000 },
    ])
  })

  it('pays the OLDEST first within a category', () => {
    const twoRents = [
      { id: 'sep', type: 'RENT', outstandingCents: 150_000, dueOn: '2026-09-01' },
      { id: 'aug', type: 'RENT', outstandingCents: 150_000, dueOn: '2026-08-01' },
    ]
    const result = allocatePayment(150_000, twoRents, ['RENT'])
    expect(result.applications).toEqual([{ chargeId: 'aug', appliedCents: 150_000 }])
  })

  it('sorts a type the jurisdiction never mentioned LAST', () => {
    // A jurisdiction that bothered to list types was being specific about
    // those; an unlisted one is not silently promoted ahead of one somebody
    // legislated about.
    const withUnknown = [
      { id: 'odd', type: 'SOMETHING_ELSE', outstandingCents: 1_000, dueOn: '2026-01-01' },
      { id: 'rent', type: 'RENT', outstandingCents: 1_000, dueOn: '2026-08-01' },
    ]
    const result = allocatePayment(1_000, withUnknown, ['RENT'])
    expect(result.applications).toEqual([{ chargeId: 'rent', appliedCents: 1_000 }])
  })

  it('returns an overpayment as unapplied rather than swallowing it', () => {
    // A tenant who overpays has a credit balance. Losing it would lose their
    // money.
    const result = allocatePayment(200_000, charges, ['RENT', 'LATE_FEE', 'NSF_FEE'])
    expect(result.unappliedCents).toBe(200_000 - 158_500)
  })

  it('applies nothing when there is nothing outstanding', () => {
    expect(allocatePayment(50_000, [], ['RENT'])).toEqual({
      applications: [],
      unappliedCents: 50_000,
    })
  })

  it('ignores charges with nothing left on them', () => {
    const settled = [{ id: 'x', type: 'RENT', outstandingCents: 0, dueOn: '2026-08-01' }]
    expect(allocatePayment(10_000, settled, ['RENT']).applications).toEqual([])
  })

  it('never applies more than a charge’s outstanding amount', () => {
    const result = allocatePayment(999_999, charges, ['RENT', 'LATE_FEE', 'NSF_FEE'])
    for (const application of result.applications) {
      const charge = charges.find((c) => c.id === application.chargeId)!
      expect(application.appliedCents).toBeLessThanOrEqual(charge.outstandingCents)
    }
  })

  it('is deterministic when type and date tie', () => {
    // These amounts are written to a ledger and compared in tests.
    const tied = [
      { id: 'b', type: 'RENT', outstandingCents: 1_000, dueOn: '2026-08-01' },
      { id: 'a', type: 'RENT', outstandingCents: 1_000, dueOn: '2026-08-01' },
    ]
    expect(allocatePayment(1_000, tied, ['RENT']).applications[0]!.chargeId).toBe('a')
    expect(
      allocatePayment(1_000, [...tied].reverse(), ['RENT']).applications[0]!.chargeId,
    ).toBe('a')
  })

  it('refuses a negative payment', () => {
    expect(() => allocatePayment(-100, charges, ['RENT'])).toThrow(/cannot be negative/)
  })

  it('falls back to RENT-FIRST when a jurisdiction states no order', () => {
    // The safe default rather than a neutral one: it minimises the chance of
    // serving a pay-or-quit notice on somebody who has in fact paid rent.
    expect(allocationOrderFor({ paymentAllocationOrder: [] })[0]).toBe('RENT')
    expect(DEFAULT_ALLOCATION_ORDER[0]).toBe('RENT')
  })

  it('uses the jurisdiction’s order when it states one', () => {
    expect(allocationOrderFor({ paymentAllocationOrder: ['LATE_FEE', 'RENT'] })).toEqual([
      'LATE_FEE',
      'RENT',
    ])
  })
})

describe('balanceCents', () => {
  const rows = [
    { id: '1', type: 'CHARGE', amountCents: 150_000, occurredAt: new Date('2026-08-01'), description: 'Rent' },
    { id: '2', type: 'PAYMENT', amountCents: -150_000, occurredAt: new Date('2026-08-03'), description: 'Paid' },
  ]

  it('is a plain sum of the signed amounts', () => {
    expect(balanceCents(rows)).toBe(0)
  })

  it('is zero for an empty ledger', () => {
    expect(balanceCents([])).toBe(0)
  })

  it('reports a CREDIT balance rather than clamping at zero', () => {
    // An overpayment is a real state. Clamping would lose money the tenant
    // has actually paid.
    expect(balanceCents([...rows, { ...rows[1]!, id: '3', amountCents: -5_000 }])).toBe(
      -5_000,
    )
  })

  it('refuses a fractional cent', () => {
    expect(() =>
      balanceCents([{ ...rows[0]!, amountCents: 100.5 }]),
    ).toThrow(/integer cents/)
  })
})

describe('statement', () => {
  it('sorts chronologically and carries a running balance', () => {
    // Fed out of order deliberately - the function sorts, not the caller.
    // A caller that forgot would produce a running balance that is
    // arithmetically correct and completely wrong.
    const lines = statement([
      { id: 'b', type: 'PAYMENT', amountCents: -50_000, occurredAt: new Date('2026-08-05'), description: 'Part payment' },
      { id: 'a', type: 'CHARGE', amountCents: 150_000, occurredAt: new Date('2026-08-01'), description: 'Rent' },
      { id: 'c', type: 'CHARGE', amountCents: 5_000, occurredAt: new Date('2026-08-08'), description: 'Late fee' },
    ])
    expect(lines.map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(lines.map((l) => l.runningBalanceCents)).toEqual([150_000, 100_000, 105_000])
  })

  it('breaks a tie on id so the order is stable', () => {
    const at = new Date('2026-08-01')
    const lines = statement([
      { id: 'z', type: 'PAYMENT', amountCents: -1, occurredAt: at, description: '' },
      { id: 'a', type: 'CHARGE', amountCents: 1, occurredAt: at, description: '' },
    ])
    expect(lines.map((l) => l.id)).toEqual(['a', 'z'])
  })
})

describe('reversedEntryIds', () => {
  it('names the entries a reversal points at', () => {
    // D-11: corrections are a new REVERSAL row, never an edit - so the
    // original stays visible and the reader sees what happened.
    const ids = reversedEntryIds([
      { id: '1', type: 'PAYMENT', amountCents: -100, occurredAt: new Date(), description: '' },
      { id: '2', type: 'REVERSAL', amountCents: 100, occurredAt: new Date(), description: '', reversesId: '1' },
    ])
    expect([...ids]).toEqual(['1'])
  })
})

describe('detectDrift', () => {
  const projected = {
    stripeEventId: 'evt_1',
    outcome: 'projected',
    type: 'invoice.payment_succeeded',
    amountCents: 150_000,
    expectsLedgerRow: true,
  }
  const entry = { id: 'le_1', stripeEventId: 'evt_1', amountCents: -150_000 }

  it('reports NOTHING when the log and the projection agree', () => {
    expect(detectDrift([projected], [entry])).toEqual([])
  })

  it('catches a projection that was lost', () => {
    // The most serious kind: money Stripe reported is missing from the books
    // and nothing else would ever notice.
    const drift = detectDrift([projected], [])
    expect(drift).toHaveLength(1)
    expect(drift[0]!.kind).toBe('projected_but_missing')
    expect(drift[0]!.differenceCents).toBe(150_000)
  })

  it('catches a ledger row nobody has an event for', () => {
    // Either the log was truncated or something wrote to the projection
    // directly, which D-11 forbids outright.
    const drift = detectDrift([], [entry])
    expect(drift[0]!.kind).toBe('orphan_entry')
    expect(drift[0]!.ledgerEntryId).toBe('le_1')
  })

  it('catches a claim the pipeline never resolved', () => {
    const drift = detectDrift([{ ...projected, outcome: 'received' }], [])
    expect(drift[0]!.kind).toBe('stuck_claim')
  })

  it('still catches a LOST projection with no amount to compare', () => {
    // The internal sweep has no independent figure - both amounts it could
    // read were written by the same code from the same event - so it passes
    // null. The most serious drift must still be caught without one.
    const drift = detectDrift([{ ...projected, amountCents: null }], [])
    expect(drift).toHaveLength(1)
    expect(drift[0]!.kind).toBe('projected_but_missing')
  })

  it('does NOT report an amount mismatch when there is no amount to check', () => {
    // Silence here is honest: checking `Payment.amountCents` against
    // `LedgerEntry.amountCents` would always pass and look like coverage.
    expect(
      detectDrift([{ ...projected, amountCents: null }], [
        { id: 'le_1', stripeEventId: 'evt_1', amountCents: -1 },
      ]),
    ).toEqual([])
  })

  it('catches an amount that disagrees', () => {
    const drift = detectDrift([projected], [{ ...entry, amountCents: -100_000 }])
    expect(drift[0]!.kind).toBe('amount_mismatch')
    expect(drift[0]!.differenceCents).toBe(100_000 - 150_000)
  })

  it('compares ABSOLUTE values, or every payment would look wrong', () => {
    // The event reports what moved; the ledger row carries the sign the
    // projection decided.
    expect(detectDrift([projected], [{ ...entry, amountCents: -150_000 }])).toEqual([])
  })

  it('expects no row for an event that legitimately produced none', () => {
    // An ignored event, and a projected event that moves no balance (a
    // failed payment), are both legitimately rowless.
    expect(
      detectDrift(
        [
          { stripeEventId: 'evt_x', outcome: 'ignored', type: 'customer.discount.created', amountCents: null, expectsLedgerRow: false },
          { stripeEventId: 'evt_y', outcome: 'projected', type: 'invoice.payment_failed', amountCents: null, expectsLedgerRow: false },
        ],
        [],
      ),
    ).toEqual([])
  })

  it('sums several rows projected from one event', () => {
    expect(
      detectDrift([projected], [
        { id: 'a', stripeEventId: 'evt_1', amountCents: -100_000 },
        { id: 'b', stripeEventId: 'evt_1', amountCents: -50_000 },
      ]),
    ).toEqual([])
  })
})

describe('detectLeaseBalanceDrift', () => {
  // R-163: the external half detectDrift cannot do - there is no event to
  // key on here, only what Stripe's own open invoices say a LEASE owes
  // against what the projection says.

  it('reports NOTHING when Stripe and the projection agree', () => {
    expect(
      detectLeaseBalanceDrift([
        { leaseId: 'l1', stripeBalanceCents: 150_000, projectedBalanceCents: 150_000 },
      ]),
    ).toEqual([])
  })

  it('catches the shape R-038a actually missed: money Stripe never emitted an event for', () => {
    // An offline payment recorded outside the webhook pipeline leaves both
    // halves of detectDrift agreeing (both empty) while the lease's real
    // balance has moved. Only asking Stripe what IT thinks this lease owes
    // notices.
    const drift = detectLeaseBalanceDrift([
      { leaseId: 'l1', stripeBalanceCents: 150_000, projectedBalanceCents: 0 },
    ])
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({
      kind: 'amount_mismatch',
      leaseId: 'l1',
      stripeEventId: null,
      differenceCents: -150_000,
    })
  })

  it('does NOT report drift when Stripe could not be asked', () => {
    // Null is "we could not ask", not "nothing owed" - the same distinction
    // switchDecision draws. Guessing here would report drift on every lease
    // in a network hiccup.
    expect(
      detectLeaseBalanceDrift([
        { leaseId: 'l1', stripeBalanceCents: null, projectedBalanceCents: 150_000 },
      ]),
    ).toEqual([])
  })
})
