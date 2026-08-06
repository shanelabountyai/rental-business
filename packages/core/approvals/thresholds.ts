// Work-order approval thresholds (MAINT-04, ROLE-02, R-026).
//
// TWO DIFFERENT NUMBERS GOVERN ONE DECISION, and conflating them is the bug
// this file exists to prevent:
//
//   THE ENTITY'S THRESHOLD ("above $500 I want to see it") is about the
//   MONEY. It is the owner saying which spends are big enough to be worth
//   their attention, and it applies no matter who is asking.
//
//   A STAFF CEILING ("this manager may approve up to $300") is about the
//   PERSON. It is R-004's `checkMonetaryAuthority()`, already built and
//   tested, and it answers a different question: may THIS actor be the one
//   who says yes.
//
// MAINT-04 needs both, in that order: first decide whether an approval is
// required at all, then decide whether the person in front of us is allowed
// to give it. A work order under the threshold needs no approval from
// anyone; one over it needs an approval from somebody whose ceiling covers
// it. Checking only the ceiling would send every $10 filter change up for
// signature; checking only the threshold would let a $300-ceiling manager
// approve $5,000.

/// Used when an entity has not configured its own. Deliberately conservative
/// - a portfolio that has never thought about this gets asked about spends
/// over $500 rather than never being asked at all.
///
/// ponytail: constants rather than a settings table, because these are three
/// numbers on an entity that already exists. D-4's never-hardcode rule is
/// about jurisdiction-dependent values a statute can change; no statute sets
/// an owner's own comfort with a repair bill.
export const APPROVAL_DEFAULTS = {
  /// Above this estimate, somebody has to say yes before dispatch.
  thresholdCents: 50_000,
  /// How far actuals may run over what was approved before it goes back.
  tolerancePercent: 10,
  /// Above this, collect competing bids rather than dispatching one vendor.
  bidThresholdCents: 250_000,
} as const

export interface ApprovalPolicy {
  approvalThresholdCents: number | null
  actualsTolerancePercent: number | null
  bidThresholdCents: number | null
}

export interface ResolvedPolicy {
  thresholdCents: number
  tolerancePercent: number
  bidThresholdCents: number
}

/// Falls back per FIELD, not per object: an entity that set a threshold but
/// never thought about tolerance keeps its threshold and gets the default
/// tolerance. `??`, not `||` - a configured zero threshold means "approve
/// everything", which is a real policy a cautious owner might set, and `||`
/// would silently replace it with $500.
export function resolvePolicy(policy: ApprovalPolicy | null): ResolvedPolicy {
  return {
    thresholdCents: policy?.approvalThresholdCents ?? APPROVAL_DEFAULTS.thresholdCents,
    tolerancePercent:
      policy?.actualsTolerancePercent ?? APPROVAL_DEFAULTS.tolerancePercent,
    bidThresholdCents: policy?.bidThresholdCents ?? APPROVAL_DEFAULTS.bidThresholdCents,
  }
}

export type ApprovalRequirement =
  /// Under the threshold. Nobody needs to sign off; dispatch away.
  | { outcome: 'not_required' }
  /// Over the threshold, so somebody has to say yes before dispatch.
  | { outcome: 'required'; thresholdCents: number }
  /// Over the BID threshold too - MAINT-04 wants competing bids at this
  /// size, not just a signature on the first number that came in.
  | { outcome: 'required'; thresholdCents: number; bidsExpected: true }

/**
 * Whether this work order needs an approval before it can be dispatched.
 *
 * A work order with NO estimate needs no approval, and that is deliberate
 * rather than an oversight: R-024 made the estimate optional precisely
 * because a PM creating a work order while a tech is standing in the unit
 * often does not have one, and blocking dispatch on a number nobody has yet
 * would stop the emergency work this product exists to move quickly. The
 * control that catches it is the ACTUALS check below - an unestimated job
 * whose invoice lands over the threshold goes for approval before it can
 * close, so the money is still seen, just later.
 */
export function approvalRequirement(
  estimateCents: number | null | undefined,
  policy: ResolvedPolicy,
): ApprovalRequirement {
  if (estimateCents == null) return { outcome: 'not_required' }
  if (estimateCents <= policy.thresholdCents) return { outcome: 'not_required' }
  if (estimateCents > policy.bidThresholdCents) {
    return { outcome: 'required', thresholdCents: policy.thresholdCents, bidsExpected: true }
  }
  return { outcome: 'required', thresholdCents: policy.thresholdCents }
}

/// The total a tolerance check measures. Actuals are labour plus materials;
/// the invoice is what the vendor billed. The HIGHER of the two governs,
/// because either one exceeding what was approved is money the owner did not
/// agree to - and a vendor whose invoice beats our own recorded actuals is
/// exactly the case worth catching.
export function actualTotalCents(workOrder: {
  actualLaborCents: number | null
  actualMaterialsCents: number | null
  invoiceCents: number | null
}): number | null {
  const parts =
    (workOrder.actualLaborCents ?? 0) + (workOrder.actualMaterialsCents ?? 0)
  const hasParts = workOrder.actualLaborCents != null || workOrder.actualMaterialsCents != null
  const candidates = [
    hasParts ? parts : null,
    workOrder.invoiceCents,
  ].filter((value): value is number => value != null)

  return candidates.length === 0 ? null : Math.max(...candidates)
}

export type ReapprovalVerdict =
  | { outcome: 'within_tolerance' }
  | {
      outcome: 'reapproval_required'
      approvedCents: number
      actualCents: number
      allowedCents: number
    }

/**
 * MAINT-04: "Given actuals exceeding approval by more than tolerance, when
 * updated, then re-approval is required before closure."
 *
 * Measured against `approvedAmountCents` - what somebody with authority
 * actually agreed to - NOT against the current estimate, which can be
 * revised after the fact and would make this check trivially defeatable by
 * editing a number.
 *
 * A work order that never needed an approval has nothing to exceed, so it is
 * within tolerance by definition here; the "was this ever over the
 * threshold" question is `approvalRequirement()`'s, and the caller asks both.
 * Keeping them separate is what stops a $50 job being dragged into an
 * approval flow because its actuals came in at $60.
 */
export function reapprovalCheck(
  approvedAmountCents: number | null | undefined,
  actualCents: number | null | undefined,
  policy: ResolvedPolicy,
): ReapprovalVerdict {
  if (approvedAmountCents == null || actualCents == null) {
    return { outcome: 'within_tolerance' }
  }
  // Rounded rather than truncated, and computed in integer cents throughout
  // (D-3): a 10% tolerance on $500 is exactly $50, and floating-point
  // arithmetic on money is how $550.00 becomes "over" by a hundredth of a
  // cent.
  const allowedCents =
    approvedAmountCents + Math.round((approvedAmountCents * policy.tolerancePercent) / 100)

  if (actualCents <= allowedCents) return { outcome: 'within_tolerance' }
  return {
    outcome: 'reapproval_required',
    approvedCents: approvedAmountCents,
    actualCents,
    allowedCents,
  }
}
