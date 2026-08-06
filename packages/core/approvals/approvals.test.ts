import { describe, expect, it } from 'vitest'
import type { AuthorityDecision } from '../rbac/authority.ts'
import {
  APPROVAL_DEFAULTS,
  actualTotalCents,
  approvalRequirement,
  approvalRoute,
  compareBids,
  isApprovalDecision,
  reapprovalCheck,
  resolvePolicy,
  validateApprovalDecision,
  validateBid,
} from './index.ts'

describe('resolvePolicy', () => {
  it('falls back to defaults when an entity has configured nothing', () => {
    expect(resolvePolicy(null)).toEqual({
      thresholdCents: APPROVAL_DEFAULTS.thresholdCents,
      tolerancePercent: APPROVAL_DEFAULTS.tolerancePercent,
      bidThresholdCents: APPROVAL_DEFAULTS.bidThresholdCents,
    })
  })

  it('falls back per FIELD, not per object', () => {
    const resolved = resolvePolicy({
      approvalThresholdCents: 20_000,
      actualsTolerancePercent: null,
      bidThresholdCents: null,
    })
    expect(resolved.thresholdCents).toBe(20_000)
    expect(resolved.tolerancePercent).toBe(APPROVAL_DEFAULTS.tolerancePercent)
  })

  it('KEEPS a configured zero threshold - "approve everything" is a real policy', () => {
    // The `??` vs `||` bug this test exists to catch: `||` would silently
    // replace a deliberate 0 with the $500 default, quietly turning the most
    // cautious possible setting into a permissive one.
    const resolved = resolvePolicy({
      approvalThresholdCents: 0,
      actualsTolerancePercent: 0,
      bidThresholdCents: 0,
    })
    expect(resolved.thresholdCents).toBe(0)
    expect(resolved.tolerancePercent).toBe(0)
    expect(resolved.bidThresholdCents).toBe(0)
  })
})

describe('approvalRequirement', () => {
  const policy = { thresholdCents: 50_000, tolerancePercent: 10, bidThresholdCents: 250_000 }

  it('needs no approval at or below the threshold', () => {
    expect(approvalRequirement(0, policy).outcome).toBe('not_required')
    expect(approvalRequirement(49_999, policy).outcome).toBe('not_required')
    // Boundary: exactly AT the threshold is under it, not over.
    expect(approvalRequirement(50_000, policy).outcome).toBe('not_required')
  })

  it('requires approval one cent over', () => {
    expect(approvalRequirement(50_001, policy)).toEqual({
      outcome: 'required',
      thresholdCents: 50_000,
    })
  })

  it("MAINT-04's own worked example: a $500 threshold and a $650 estimate", () => {
    const result = approvalRequirement(65_000, { ...policy, thresholdCents: 50_000 })
    expect(result.outcome).toBe('required')
  })

  it('expects competing bids above the bid threshold', () => {
    const result = approvalRequirement(300_000, policy)
    expect(result).toMatchObject({ outcome: 'required', bidsExpected: true })
  })

  it('requires nothing when there is no estimate yet - the actuals check catches it later', () => {
    // R-024 made the estimate optional on purpose: a PM creating a work
    // order with a tech already in the unit often has no number, and
    // blocking dispatch on one would stop emergency work. The money is still
    // seen, just at the actuals stage instead.
    expect(approvalRequirement(null, policy).outcome).toBe('not_required')
    expect(approvalRequirement(undefined, policy).outcome).toBe('not_required')
  })

  it('requires approval for everything when the threshold is zero', () => {
    expect(approvalRequirement(1, { ...policy, thresholdCents: 0 }).outcome).toBe('required')
  })
})

describe('approvalRoute', () => {
  const allowed: AuthorityDecision = { outcome: 'allowed' }
  const escalate: AuthorityDecision = {
    outcome: 'escalate',
    ceilingCents: 30_000,
    requestedCents: 65_000,
  }
  const denied: AuthorityDecision = { outcome: 'denied', reason: 'no_authority' }

  it('asks about the MONEY before the PERSON', () => {
    // A maintenance tech with a zero ceiling can still dispatch a $40 filter
    // change. Asking about their authority first would stop them - this is
    // the ordering bug the whole function exists to prevent.
    expect(approvalRoute(false, denied)).toEqual({ route: 'no_approval_needed' })
    expect(approvalRoute(false, escalate)).toEqual({ route: 'no_approval_needed' })
  })

  it('lets an actor whose ceiling covers it approve on the spot', () => {
    expect(approvalRoute(true, allowed)).toEqual({ route: 'self_approve' })
  })

  it("ROUTES UP rather than failing - MAINT-04's 'automatically'", () => {
    // The distinction that matters: over-ceiling is not an error, it is a
    // different destination. A caller treating this as a refusal would build
    // the wrong flow entirely.
    expect(approvalRoute(true, escalate)).toEqual({
      route: 'escalate',
      ceilingCents: 30_000,
      requestedCents: 65_000,
    })
  })

  it('distinguishes a zero-ceiling actor from an over-ceiling one', () => {
    // A tech should not be generating approval requests for the owner every
    // time they open a work order; somebody who can approve has to ask.
    expect(approvalRoute(true, denied)).toEqual({
      route: 'not_permitted',
      reason: 'no_authority',
    })
  })
})

describe('actualTotalCents', () => {
  it('is null when nothing has been recorded', () => {
    expect(
      actualTotalCents({ actualLaborCents: null, actualMaterialsCents: null, invoiceCents: null }),
    ).toBeNull()
  })

  it('adds labour and materials', () => {
    expect(
      actualTotalCents({
        actualLaborCents: 20_000,
        actualMaterialsCents: 15_000,
        invoiceCents: null,
      }),
    ).toBe(35_000)
  })

  it('takes the HIGHER of our own actuals and the vendor invoice', () => {
    // A vendor billing more than we recorded is exactly the case worth
    // catching, so the invoice wins when it is larger.
    expect(
      actualTotalCents({
        actualLaborCents: 20_000,
        actualMaterialsCents: 5_000,
        invoiceCents: 40_000,
      }),
    ).toBe(40_000)
    expect(
      actualTotalCents({
        actualLaborCents: 20_000,
        actualMaterialsCents: 30_000,
        invoiceCents: 40_000,
      }),
    ).toBe(50_000)
  })

  it('treats a recorded zero as recorded, not as missing', () => {
    expect(
      actualTotalCents({ actualLaborCents: 0, actualMaterialsCents: null, invoiceCents: null }),
    ).toBe(0)
  })
})

describe('reapprovalCheck', () => {
  const policy = { thresholdCents: 50_000, tolerancePercent: 10, bidThresholdCents: 250_000 }

  it('allows actuals up to exactly the tolerance', () => {
    // $500 approved, 10% tolerance, $550 actual - exactly at the line, which
    // is within it.
    expect(reapprovalCheck(50_000, 55_000, policy)).toEqual({ outcome: 'within_tolerance' })
  })

  it('requires re-approval one cent past it', () => {
    expect(reapprovalCheck(50_000, 55_001, policy)).toEqual({
      outcome: 'reapproval_required',
      approvedCents: 50_000,
      actualCents: 55_001,
      allowedCents: 55_000,
    })
  })

  it('is silent for a work order that never needed approving', () => {
    // A $50 job whose actuals came in at $60 must not be dragged into an
    // approval flow. "Was this ever over the threshold" is a different
    // question, asked by approvalRequirement().
    expect(reapprovalCheck(null, 6_000, policy)).toEqual({ outcome: 'within_tolerance' })
  })

  it('is silent until actuals exist', () => {
    expect(reapprovalCheck(50_000, null, policy)).toEqual({ outcome: 'within_tolerance' })
  })

  it('measures against what was APPROVED, not a since-revised estimate', () => {
    // The defeat this guards against: approve $500, then edit the estimate
    // to $5,000, then spend $900 and claim it was within tolerance. The
    // function only ever sees approvedAmountCents.
    expect(reapprovalCheck(50_000, 90_000, policy).outcome).toBe('reapproval_required')
  })

  it('handles a zero tolerance - any overrun goes back', () => {
    const strict = { ...policy, tolerancePercent: 0 }
    expect(reapprovalCheck(50_000, 50_000, strict).outcome).toBe('within_tolerance')
    expect(reapprovalCheck(50_000, 50_001, strict).outcome).toBe('reapproval_required')
  })

  it('stays in integer cents - no floating-point drift at the boundary', () => {
    // 33% of $333.33 is 109.9989 cents of a cent's worth of trouble if this
    // is ever done in floats.
    const odd = { ...policy, tolerancePercent: 33 }
    const result = reapprovalCheck(33_333, 44_333, odd)
    expect(Number.isInteger((result as { allowedCents: number }).allowedCents ?? 0)).toBe(true)
  })
})

describe('validateApprovalDecision', () => {
  it('accepts a plain approval', () => {
    expect(validateApprovalDecision({ decision: 'APPROVE' })).toEqual([])
  })

  it('rejects an invented decision', () => {
    expect(validateApprovalDecision({ decision: 'MAYBE' }).map((v) => v.field)).toContain(
      'decision',
    )
  })

  it('requires a reason on a denial', () => {
    expect(validateApprovalDecision({ decision: 'DENY' }).map((v) => v.field)).toContain(
      'denialReason',
    )
    expect(
      validateApprovalDecision({ decision: 'DENY', denialReason: 'Get a second quote' }),
    ).toEqual([])
  })

  it('requires the actual question on an ask', () => {
    expect(validateApprovalDecision({ decision: 'ASK' }).map((v) => v.field)).toContain('question')
    expect(
      validateApprovalDecision({ decision: 'ASK', question: 'Is the water heater under warranty?' }),
    ).toEqual([])
  })
})

describe('isApprovalDecision', () => {
  it('recognises its own vocabulary and nothing else', () => {
    expect(isApprovalDecision('APPROVE')).toBe(true)
    expect(isApprovalDecision('approve')).toBe(false)
  })
})

describe('validateBid', () => {
  it('accepts a price', () => {
    expect(validateBid({ amountCents: 45_000 })).toEqual([])
  })

  it('accepts a decline with no price at all', () => {
    expect(validateBid({ declined: true })).toEqual([])
  })

  it('requires a price when not declining', () => {
    expect(validateBid({}).map((v) => v.field)).toContain('amountCents')
  })

  it('rejects a negative or fractional price', () => {
    expect(validateBid({ amountCents: -1 }).length).toBe(1)
    expect(validateBid({ amountCents: 10.5 }).length).toBe(1)
  })
})

describe('compareBids', () => {
  const asked = (over: Partial<{ vendorId: string; vendorName: string; amountCents: number | null; declinedAt: Date | null; respondedAt: Date | null }>) => ({
    vendorId: 'v',
    vendorName: 'V',
    amountCents: null,
    declinedAt: null,
    respondedAt: null,
    ...over,
  })

  it('sorts quotes cheapest first, then declines, then silence', () => {
    const result = compareBids([
      asked({ vendorId: 'silent', vendorName: 'Silent' }),
      asked({ vendorId: 'dear', vendorName: 'Dear', amountCents: 90_000, respondedAt: new Date() }),
      asked({ vendorId: 'no', vendorName: 'No', declinedAt: new Date(), respondedAt: new Date() }),
      asked({ vendorId: 'cheap', vendorName: 'Cheap', amountCents: 40_000, respondedAt: new Date() }),
    ])
    expect(result.bids.map((b) => b.vendorId)).toEqual(['cheap', 'dear', 'no', 'silent'])
    expect(result.lowestCents).toBe(40_000)
  })

  it('KEEPS the vendors who never answered on the list', () => {
    // A comparison that silently drops the two who ignored you tells the
    // wrong story about how much shopping around actually happened.
    const result = compareBids([
      asked({ vendorId: 'a', amountCents: 10_000, respondedAt: new Date() }),
      asked({ vendorId: 'b' }),
      asked({ vendorId: 'c' }),
    ])
    expect(result.bids).toHaveLength(3)
    expect(result.outstandingCount).toBe(2)
  })

  it('does not treat a decline as a cheap quote', () => {
    const result = compareBids([
      asked({ vendorId: 'no', declinedAt: new Date(), respondedAt: new Date() }),
      asked({ vendorId: 'yes', amountCents: 70_000, respondedAt: new Date() }),
    ])
    expect(result.lowestCents).toBe(70_000)
    expect(result.quotedCount).toBe(1)
  })

  it("needs two real prices before it is a comparison (MAINT-04's 'collect 2-3')", () => {
    const one = compareBids([asked({ amountCents: 10_000, respondedAt: new Date() })])
    expect(one.enoughToCompare).toBe(false)
    const two = compareBids([
      asked({ vendorId: 'a', amountCents: 10_000, respondedAt: new Date() }),
      asked({ vendorId: 'b', amountCents: 20_000, respondedAt: new Date() }),
    ])
    expect(two.enoughToCompare).toBe(true)
  })

  it('handles nobody having been asked yet', () => {
    const result = compareBids([])
    expect(result.lowestCents).toBeNull()
    expect(result.enoughToCompare).toBe(false)
  })
})
