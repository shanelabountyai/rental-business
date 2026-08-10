import { describe, expect, it } from 'vitest'
import {
  activationGaps,
  canGiveNotice,
  inheritedGaps,
  leaseIsInForce,
  leaseIsOver,
  leaseTransition,
  validateGuarantor,
  validateLease,
} from './index.ts'

const START = new Date('2026-01-01T00:00:00Z')
const END = new Date('2026-12-31T00:00:00Z')

function facts(over: Partial<Parameters<typeof leaseTransition>[0]> = {}) {
  return {
    status: 'DRAFT',
    tenantCount: 1,
    rentCents: 150_000,
    startsOn: START,
    endsOn: END,
    isMonthToMonth: false,
    ...over,
  }
}

describe('leaseIsInForce / leaseIsOver', () => {
  it('counts ACTIVE and MONTH_TO_MONTH as running', () => {
    expect(leaseIsInForce('ACTIVE')).toBe(true)
    expect(leaseIsInForce('MONTH_TO_MONTH')).toBe(true)
  })

  it('does NOT count a draft or an awaiting-signature lease as running', () => {
    // Rent is not due on a lease nobody has signed.
    expect(leaseIsInForce('DRAFT')).toBe(false)
    expect(leaseIsInForce('PENDING_SIGNATURE')).toBe(false)
  })

  it('treats ended and terminated as over', () => {
    expect(leaseIsOver('ENDED')).toBe(true)
    expect(leaseIsOver('TERMINATED')).toBe(true)
    expect(leaseIsOver('ACTIVE')).toBe(false)
  })
})

describe('leaseTransition', () => {
  it('walks the ordinary path: draft → awaiting signature → active', () => {
    expect(leaseTransition(facts(), 'PENDING_SIGNATURE').allowed).toBe(true)
    expect(
      leaseTransition(facts({ status: 'PENDING_SIGNATURE' }), 'ACTIVE').allowed,
    ).toBe(true)
  })

  it('allows DRAFT straight to ACTIVE - the inherited path', () => {
    // RISK-08: there is nothing to sign, because the signing happened years
    // ago with somebody else.
    expect(leaseTransition(facts(), 'ACTIVE').allowed).toBe(true)
  })

  it('rolls an active lease to month-to-month, one way only', () => {
    expect(leaseTransition(facts({ status: 'ACTIVE' }), 'MONTH_TO_MONTH').allowed).toBe(
      true,
    )
    // Agreeing a new fixed term is a NEW lease (LEASE-09), not this one
    // reverting.
    expect(
      leaseTransition(facts({ status: 'MONTH_TO_MONTH' }), 'ACTIVE').allowed,
    ).toBe(false)
  })

  it('REFUSES to reopen an ended or terminated lease', () => {
    // The most important refusal here. A tenancy that restarts is a new
    // lease; editing the old one's dates and rent to mean something else
    // destroys the evidence a deposit disposition is defended with.
    for (const from of ['ENDED', 'TERMINATED'] as const) {
      const decision = leaseTransition(facts({ status: from }), 'ACTIVE')
      expect(decision.allowed).toBe(false)
      expect(decision.message).toMatch(/new lease/)
    }
  })

  it('refuses to un-start an active lease', () => {
    expect(leaseTransition(facts({ status: 'ACTIVE' }), 'DRAFT').allowed).toBe(false)
  })

  it('DEMANDS a reason to terminate, and only to terminate', () => {
    const noReason = leaseTransition(facts({ status: 'ACTIVE' }), 'TERMINATED')
    expect(noReason.allowed).toBe(false)
    expect(noReason.refusal).toBe('reason_required')

    expect(
      leaseTransition(facts({ status: 'ACTIVE' }), 'TERMINATED', 'Mutual release').allowed,
    ).toBe(true)
    // Ending normally needs none.
    expect(leaseTransition(facts({ status: 'ACTIVE' }), 'ENDED').allowed).toBe(true)
  })

  it('treats whitespace as no reason at all', () => {
    expect(
      leaseTransition(facts({ status: 'ACTIVE' }), 'TERMINATED', '   ').refusal,
    ).toBe('reason_required')
  })

  it('reports staying put as already_there rather than a failure', () => {
    expect(leaseTransition(facts({ status: 'ACTIVE' }), 'ACTIVE').refusal).toBe(
      'already_there',
    )
  })

  it('refuses to activate a lease with nobody on it', () => {
    const decision = leaseTransition(facts({ tenantCount: 0 }), 'ACTIVE')
    expect(decision.allowed).toBe(false)
    expect(decision.refusal).toBe('incomplete')
    expect(decision.message).toMatch(/nobody is on it/)
  })
})

describe('activationGaps', () => {
  it('is empty for a complete fixed-term lease', () => {
    expect(activationGaps(facts())).toEqual([])
  })

  it('is empty for a complete month-to-month lease', () => {
    expect(activationGaps(facts({ isMonthToMonth: true, endsOn: null }))).toEqual([])
  })

  it('demands an end date on a fixed term', () => {
    // Without one, LEASE-09's renewal flags never fire and the tenancy
    // silently runs forever.
    expect(activationGaps(facts({ endsOn: null }))).toContain(
      'a fixed-term lease needs an end date',
    )
  })

  it('REFUSES an end date on a month-to-month lease', () => {
    // R-009's auto-make-ready job keys on exactly this column - an MTM
    // lease carrying an end date would have its unit flipped to make-ready
    // out from under a tenant who still lives there.
    expect(activationGaps(facts({ isMonthToMonth: true }))).toContain(
      'a month-to-month lease should not have an end date',
    )
  })

  it('refuses a lease that ends before it starts', () => {
    expect(
      activationGaps(facts({ endsOn: new Date('2025-01-01T00:00:00Z') })),
    ).toContain('it ends before it starts')
  })

  it('reports every gap at once rather than one at a time', () => {
    // Somebody fixing a half-entered lease should be told everything, not
    // discover the next problem after each save.
    expect(activationGaps(facts({ tenantCount: 0, endsOn: null })).length).toBe(2)
  })
})

describe('canGiveNotice', () => {
  it('allows notice on a running tenancy', () => {
    expect(canGiveNotice({ status: 'ACTIVE', noticeGivenAt: null }).allowed).toBe(true)
    expect(
      canGiveNotice({ status: 'MONTH_TO_MONTH', noticeGivenAt: null }).allowed,
    ).toBe(true)
  })

  it('refuses notice on a lease that is not running', () => {
    // The date it writes drives statutory clocks later; filing it against
    // the wrong tenancy is worth refusing rather than silently accepting.
    for (const status of ['DRAFT', 'PENDING_SIGNATURE', 'ENDED', 'TERMINATED']) {
      expect(canGiveNotice({ status, noticeGivenAt: null }).allowed).toBe(false)
    }
  })

  it('refuses a second notice', () => {
    expect(
      canGiveNotice({ status: 'ACTIVE', noticeGivenAt: new Date() }).refusal,
    ).toBe('already_there')
  })
})

describe('inheritedGaps', () => {
  const inherited = {
    origin: 'INHERITED',
    estoppelConfirmedAt: null,
    depositTransferStatus: 'UNKNOWN',
    hasConditionBaseline: false,
  }

  it('is empty for a lease that came through the front door', () => {
    expect(
      inheritedGaps({ ...inherited, origin: 'APPLICATION' }),
    ).toEqual([])
  })

  it('lists all three gaps on a fresh inherited tenancy', () => {
    expect(inheritedGaps(inherited).map((g) => g.gap)).toEqual([
      'estoppel',
      'deposit_transfer',
      'condition_baseline',
    ])
  })

  it('treats NOT_APPLICABLE as an unanswered question on an inherited lease', () => {
    // The single most important assertion in this file. NOT_APPLICABLE is
    // the column default, so an inherited lease nobody ever asked about
    // would otherwise sit here looking settled - which is exactly the
    // unquantified liability RISK-08 exists to prevent.
    const gaps = inheritedGaps({ ...inherited, depositTransferStatus: 'NOT_APPLICABLE' })
    expect(gaps.map((g) => g.gap)).toContain('deposit_transfer')
  })

  it('clears the deposit gap once somebody actually answers', () => {
    for (const status of ['TRANSFERRED', 'NOT_TRANSFERRED']) {
      const gaps = inheritedGaps({ ...inherited, depositTransferStatus: status })
      expect(gaps.map((g) => g.gap)).not.toContain('deposit_transfer')
    }
  })

  it('counts the seller keeping the deposit as ANSWERED, not as no deposit', () => {
    // We are very likely still liable for it either way; what matters is
    // that somebody established the fact.
    const gaps = inheritedGaps({
      ...inherited,
      depositTransferStatus: 'NOT_TRANSFERRED',
      estoppelConfirmedAt: new Date(),
      hasConditionBaseline: true,
    })
    expect(gaps).toEqual([])
  })

  it('states the consequence, not just the gap', () => {
    // A PM shown a bare checklist item does not chase it; one who
    // understands what it costs does.
    const baseline = inheritedGaps(inherited).find((g) => g.gap === 'condition_baseline')
    expect(baseline?.consequence).toMatch(/cannot charge move-out damage/)
  })
})

describe('validateLease', () => {
  const valid = {
    unitId: 'unit_1',
    startsOn: '2026-01-01',
    endsOn: '2026-12-31',
    rentDollars: '1500',
    depositDollars: '1500',
    rentDueDay: '1',
    isMonthToMonth: false,
  }

  it('accepts a complete fixed-term lease', () => {
    expect(validateLease(valid)).toEqual([])
  })

  it('caps the rent due day at 28', () => {
    // A lease due on the 30th has no due date in February, and every
    // downstream billing anchor would have to invent one.
    expect(validateLease({ ...valid, rentDueDay: '30' }).map((v) => v.field)).toContain(
      'rentDueDay',
    )
    expect(validateLease({ ...valid, rentDueDay: '28' })).toEqual([])
  })

  it('requires a unit, a start and a rent', () => {
    const violations = validateLease({
      ...valid,
      unitId: '',
      startsOn: '',
      rentDollars: '',
    })
    expect(violations.map((v) => v.field)).toEqual(
      expect.arrayContaining(['unitId', 'startsOn', 'rentDollars']),
    )
  })

  it('converts dollars to integer cents without floating point drift', () => {
    // 1234.56 * 100 is 123455.99999999999 in IEEE 754.
    expect(validateLease({ ...valid, rentDollars: '1234.56' })).toEqual([])
  })

  it('carries the activation gaps forward at entry time', () => {
    // Saving a lease in a shape that can never go live is a trap somebody
    // finds days later.
    expect(
      validateLease({ ...valid, isMonthToMonth: true }).map((v) => v.message),
    ).toContain('A month-to-month lease should not have an end date.')
  })
})

describe('validateGuarantor', () => {
  it('accepts a named guarantor with one contact route', () => {
    expect(
      validateGuarantor({ firstName: 'Dana', lastName: 'Reyes', email: 'd@example.test' }),
    ).toEqual([])
    expect(
      validateGuarantor({ firstName: 'Dana', lastName: 'Reyes', phone: '+15125550100' }),
    ).toEqual([])
  })

  it('refuses a guarantor nobody can reach', () => {
    const violations = validateGuarantor({ firstName: 'Dana', lastName: 'Reyes' })
    expect(violations[0]?.message).toMatch(/signature with nobody behind it/)
  })
})
