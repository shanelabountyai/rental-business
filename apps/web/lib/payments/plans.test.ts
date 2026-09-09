import { describe, expect, it } from 'vitest'
import { type PlanLedgerRow, type PlanRecord, paidTowardPlan, toPlanView } from './plans.ts'

// The plan arithmetic, with no database anywhere near it (PAY-08; R-187).
//
// ==========================================================================
// payment-plan-job.test.ts proves the sweep breaks a real plan on a real
// tenancy. What it cannot cheaply show is the shape of the sum itself: which
// entry types are in it, that it floors at zero rather than going negative,
// and that an ENDED plan stops counting at the moment it ended. That last one
// is R-187's defect with its sign reversed - an open-ended window swallows
// next month's rent, so a plan genuinely paid in full reads as unpaid again.
// ==========================================================================

const CHICAGO = 'America/Chicago'
const STARTED = '2026-02-15'

function entry(type: string, amountCents: number, iso: string): PlanLedgerRow {
  return { type, amountCents, occurredAt: new Date(iso) }
}

describe('paidTowardPlan', () => {
  it('nets the rent charged since the plan started off the money that arrived', () => {
    const ledger = [
      entry('CHARGE', 150_000, '2026-03-01T06:00:00Z'),
      entry('PAYMENT', -150_000, '2026-03-01T15:00:00Z'),
      entry('PAYMENT', -300_00, '2026-03-02T15:00:00Z'),
    ]
    expect(paidTowardPlan(ledger, STARTED, CHICAGO)).toBe(300_00)
  })

  it('floors at zero rather than reporting negative progress', () => {
    const ledger = [entry('CHARGE', 150_000, '2026-03-01T06:00:00Z')]
    expect(paidTowardPlan(ledger, STARTED, CHICAGO)).toBe(0)
  })

  it('takes back a payment the bank reversed, and gives back a charge that was voided', () => {
    const paid = [
      entry('PAYMENT', -300_00, '2026-03-01T15:00:00Z'),
      entry('REVERSAL', 300_00, '2026-03-03T15:00:00Z'),
    ]
    expect(paidTowardPlan(paid, STARTED, CHICAGO)).toBe(0)

    const voided = [
      entry('CHARGE', 150_000, '2026-03-01T06:00:00Z'),
      entry('REVERSAL', -150_000, '2026-03-03T06:00:00Z'),
      entry('PAYMENT', -300_00, '2026-03-04T15:00:00Z'),
    ]
    expect(paidTowardPlan(voided, STARTED, CHICAGO)).toBe(300_00)
  })

  it('counts neither a CREDIT nor an ADJUSTMENT — a plan kept by either is kept by us', () => {
    const ledger = [
      entry('CREDIT', -450_00, '2026-03-01T15:00:00Z'),
      entry('ADJUSTMENT', -450_00, '2026-03-01T15:00:00Z'),
    ]
    expect(paidTowardPlan(ledger, STARTED, CHICAGO)).toBe(0)
  })

  it('ignores anything that occurred before the start day, read in the property zone', () => {
    // 15 February at 04:00 UTC is still the 14th in Chicago, so this money
    // arrived the day BEFORE the plan started and is not an instalment on it.
    const ledger = [entry('PAYMENT', -900_00, '2026-02-15T04:00:00Z')]
    expect(paidTowardPlan(ledger, STARTED, CHICAGO)).toBe(0)
  })

  it('stops at `until` for a plan that has already ended', () => {
    const ledger = [
      entry('PAYMENT', -900_00, '2026-03-01T15:00:00Z'),
      entry('CHARGE', 150_000, '2026-04-01T06:00:00Z'),
    ]
    expect(paidTowardPlan(ledger, STARTED, CHICAGO)).toBe(0)
    expect(paidTowardPlan(ledger, STARTED, CHICAGO, new Date('2026-03-05T12:00:00Z'))).toBe(900_00)
  })
})

/// A $900 plan of three $300 instalments, in whatever state the caller names.
function planRecord(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: 'plan-1',
    leaseId: 'lease-1',
    propertyId: 'property-1',
    status: 'ACTIVE',
    arrearsCents: 900_00,
    startedOn: new Date('2026-02-15T00:00:00Z'),
    note: 'agreed on the phone',
    createdAt: new Date('2026-02-15T16:00:00Z'),
    brokenAt: null,
    brokenOn: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdBy: { name: 'Dana Manager' },
    cancelledBy: null,
    instalments: [
      { id: 'i1', sequence: 1, dueOn: new Date('2026-03-01T00:00:00Z'), amountCents: 300_00 },
      { id: 'i2', sequence: 2, dueOn: new Date('2026-04-01T00:00:00Z'), amountCents: 300_00 },
      { id: 'i3', sequence: 3, dueOn: new Date('2026-05-01T00:00:00Z'), amountCents: 300_00 },
    ],
    hold: null,
    ...overrides,
  }
}

describe('toPlanView', () => {
  const paidInFull = [entry('PAYMENT', -900_00, '2026-03-01T15:00:00Z')]
  const rentSince = entry('CHARGE', 150_000, '2026-04-01T06:00:00Z')

  it('does not un-complete a finished plan when next month`s rent is charged', () => {
    const view = toPlanView(
      planRecord({ status: 'COMPLETED', completedAt: new Date('2026-03-05T12:00:00Z') }),
      [...paidInFull, rentSince],
      CHICAGO,
      '2026-06-01',
    )
    expect(view.progress.status).toBe('COMPLETED')
    expect(view.progress.remainingCents).toBe(0)
  })

  it('leaves a plan the ledger never covered showing what was still owed when it closed', () => {
    // The R-187 case as it survives on an existing record: rent charged and
    // rent paid, nothing more, and the old arithmetic called it paid in full.
    // Nothing is backfilled, so the panel has to be able to say so.
    const view = toPlanView(
      planRecord({ status: 'COMPLETED', completedAt: new Date('2026-05-05T12:00:00Z') }),
      [
        entry('CHARGE', 150_000, '2026-03-01T06:00:00Z'),
        entry('PAYMENT', -150_000, '2026-03-01T15:00:00Z'),
      ],
      CHICAGO,
      '2026-06-01',
    )
    expect(view.progress.remainingCents).toBe(900_00)
  })

  it('measures a live plan as of today, with no upper bound', () => {
    const view = toPlanView(planRecord(), paidInFull, CHICAGO, '2026-06-01')
    expect(view.progress.status).toBe('COMPLETED')
  })
})
