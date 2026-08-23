import { describe, expect, it } from 'vitest'

import {
  BELOW_DEDUCTIBLE_WARNING,
  CLAIM_EVENT_KINDS,
  PAYMENT_CATEGORIES,
  WATER_MITIGATION_TARGET_HOURS,
  claimPosition,
  lossOfRents,
  mitigationClock,
  mitigationSummary,
  validateClaimClosure,
  type ClaimPositionFacts,
} from './index.ts'

const INCIDENT = new Date('2026-03-01T08:00:00.000Z')

describe('the mitigation clock', () => {
  it('measures to when mitigation started, not to now', () => {
    const clock = mitigationClock(
      INCIDENT,
      new Date('2026-03-01T14:00:00.000Z'),
      'WATER',
      new Date('2026-03-09T00:00:00.000Z'),
    )
    expect(clock.hoursToMitigation).toBe(6)
    expect(clock.started).toBe(true)
    // Never urgent once something has started, however late anybody is
    // reading the file afterwards.
    expect(clock.urgent).toBe(false)
  })

  it('goes urgent on a water loss past the target with nothing started', () => {
    const clock = mitigationClock(INCIDENT, null, 'WATER', new Date('2026-03-02T20:00:00.000Z'))
    expect(clock.hoursElapsed).toBeGreaterThan(WATER_MITIGATION_TARGET_HOURS)
    expect(clock.urgent).toBe(true)
    expect(mitigationSummary(clock, 'WATER')).toMatch(/trade convention, not a policy term/)
  })

  it('does not go urgent on a fire loss, where the drying clock means nothing', () => {
    const clock = mitigationClock(INCIDENT, null, 'FIRE', new Date('2026-03-05T20:00:00.000Z'))
    expect(clock.urgent).toBe(false)
  })

  it('never reports negative hours for a mitigation recorded before the incident', () => {
    const clock = mitigationClock(
      INCIDENT,
      new Date('2026-02-28T08:00:00.000Z'),
      'WATER',
      new Date('2026-03-02T08:00:00.000Z'),
    )
    expect(clock.hoursToMitigation).toBe(0)
  })
})

describe('loss of rents', () => {
  it('counts both ends of the period — a unit down on the 1st and back on the 1st was down a day', () => {
    const loss = lossOfRents(150_000, 'lease', '2026-03-01', '2026-03-01')
    expect(loss.days).toBe(1)
    expect(loss.amountCents).toBe(5_000)
  })

  it('prices a month of downtime at the contract rent', () => {
    const loss = lossOfRents(150_000, 'lease', '2026-03-01', '2026-03-30')
    expect(loss.days).toBe(30)
    expect(loss.amountCents).toBe(150_000)
  })

  // A thirtieth of a month, not a calendar day: a February loss must not be
  // worth more per day than a July one.
  it('uses a thirtieth of a month regardless of the calendar', () => {
    const february = lossOfRents(150_000, 'lease', '2026-02-01', '2026-02-28')
    const july = lossOfRents(150_000, 'lease', '2026-07-01', '2026-07-28')
    expect(february.amountCents).toBe(july.amountCents)
  })

  // The source is part of the answer: a contract rent is evidence, an asking
  // rent is an assertion the carrier will discount.
  it('reports which rent it used', () => {
    expect(lossOfRents(150_000, 'lease', '2026-03-01', '2026-03-10').source).toBe('lease')
    expect(lossOfRents(150_000, 'unit_market', '2026-03-01', '2026-03-10').source).toBe(
      'unit_market',
    )
  })
})

describe('claimPosition', () => {
  function facts(overrides: Partial<ClaimPositionFacts> = {}): ClaimPositionFacts {
    return {
      jobs: [{ invoiceCents: 800_000, actualLaborCents: null, actualMaterialsCents: null }],
      payments: [{ category: 'REPAIR', amountCents: 500_000 }],
      deductibleCents: 250_000,
      ...overrides,
    }
  }

  // ==========================================================================
  // THE LOAD-BEARING ONE. The repair cost is SUMMED FROM THE JOBS and there
  // is no column anywhere that could hold a different number (D-19). A later
  // session adding `repairCostCents` to the claim should have to delete this.
  // ==========================================================================
  it('sums the repair cost from the linked jobs, taking the invoice where there is one', () => {
    const position = claimPosition(
      facts({
        jobs: [
          { invoiceCents: 600_000, actualLaborCents: 800_000, actualMaterialsCents: 200_000 },
          { invoiceCents: null, actualLaborCents: 40_000, actualMaterialsCents: 10_000 },
        ],
      }),
    )
    // 600_000 (the invoice wins over the recorded parts) + 50_000.
    expect(position.repairCostCents).toBe(650_000)
  })

  it('reports the shortfall against the deductible', () => {
    const position = claimPosition(facts())
    expect(position.expectedRecoveryCents).toBe(550_000)
    expect(position.shortfallCents).toBe(50_000)
  })

  // Netting them would report a claim as settled while the building half was
  // still short, which is the number somebody is chasing the adjuster about.
  it('measures the shortfall against the REPAIR payments only', () => {
    const position = claimPosition(
      facts({
        payments: [
          { category: 'REPAIR', amountCents: 100_000 },
          { category: 'LOSS_OF_RENTS', amountCents: 450_000 },
        ],
      }),
    )
    expect(position.paidCents).toBe(550_000)
    expect(position.shortfallCents).toBe(450_000)
    expect(position.paidByCategory.LOSS_OF_RENTS).toBe(450_000)
  })

  // A recovery figure computed against an unknown deductible is a guess, and
  // this product says "not recorded" rather than guessing — the same posture
  // the cure clock takes on an unconfigured jurisdiction period.
  it('refuses to compute a recovery with no deductible on the policy', () => {
    const position = claimPosition(facts({ deductibleCents: null }))
    expect(position.expectedRecoveryCents).toBeNull()
    expect(position.shortfallCents).toBeNull()
    expect(position.repairCostCents).toBe(800_000)
  })

  it('flags a loss that has not cleared the deductible', () => {
    const position = claimPosition(
      facts({
        jobs: [{ invoiceCents: 180_000, actualLaborCents: null, actualMaterialsCents: null }],
      }),
    )
    expect(position.belowDeductible).toBe(true)
    expect(position.expectedRecoveryCents).toBe(0)
    expect(BELOW_DEDUCTIBLE_WARNING).toMatch(/loss history/)
  })

  it('does not flag a claim with no cost recorded yet as below the deductible', () => {
    // Nothing linked yet is "we do not know", not "it is too small".
    expect(claimPosition(facts({ jobs: [] })).belowDeductible).toBe(false)
  })
})

describe('closing a claim', () => {
  const base = {
    outcome: 'PAID' as const,
    outcomeNote: 'Settled at the adjuster’s scope less the $2,500 deductible; cheque banked 4 March.',
    paidCents: 550_000,
  }

  it('accepts a paid claim with money and an account of it', () => {
    expect(validateClaimClosure(base)).toEqual([])
  })

  it('needs an account of how it ended', () => {
    expect(validateClaimClosure({ ...base, outcomeNote: 'paid' }).map((v) => v.field)).toContain(
      'outcomeNote',
    )
  })

  // The commoner error of the two: the cheque arrived, it was banked, and
  // nobody came back to the screen.
  it('refuses a paid claim with no payment recorded', () => {
    expect(
      validateClaimClosure({ ...base, paidCents: 0 }).map((v) => v.field),
    ).toContain('outcome')
  })

  it('refuses a denied claim that has money against it', () => {
    expect(
      validateClaimClosure({ ...base, outcome: 'DENIED', paidCents: 12_000 }).map((v) => v.field),
    ).toContain('outcome')
  })

  it('accepts a withdrawn claim with nothing paid', () => {
    expect(
      validateClaimClosure({
        ...base,
        outcome: 'WITHDRAWN',
        paidCents: 0,
        outcomeNote: 'Repairs came to $1,800 against a $2,500 deductible, so it was withdrawn.',
      }),
    ).toEqual([])
  })
})

describe('the vocabularies', () => {
  it('splits payments by what they were for, because the halves are taxed differently', () => {
    expect(PAYMENT_CATEGORIES).toContain('LOSS_OF_RENTS')
    expect(PAYMENT_CATEGORIES).toContain('REPAIR')
  })

  it('carries correspondence in both directions on the one timeline', () => {
    expect(CLAIM_EVENT_KINDS).toContain('CORRESPONDENCE_IN')
    expect(CLAIM_EVENT_KINDS).toContain('CORRESPONDENCE_OUT')
  })
})
