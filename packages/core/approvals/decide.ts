// Who may give an approval, and what happens when they cannot (MAINT-04,
// ROLE-02, R-026).
//
// This is the thin, pure join between two things that already exist:
// `approvalRequirement()` next door (is an approval needed at all - about
// the MONEY) and R-004's `checkMonetaryAuthority()` (may this person give it
// - about the PERSON). Written as its own function rather than inlined at
// the call site because getting the ORDER wrong is the whole risk: ask about
// the person first and a $10 filter change gets routed up to the owner; ask
// about the money only and a $300-ceiling manager approves $5,000.

import type { AuthorityDecision } from '../rbac/authority.ts'

export type ApprovalRoute =
  /// Under the entity's threshold - dispatch, nobody signs anything.
  | { route: 'no_approval_needed' }
  /// Over the threshold and within this actor's ceiling: they can approve it
  /// themselves, right now.
  | { route: 'self_approve' }
  /// Over the threshold AND over this actor's ceiling. MAINT-04 is explicit
  /// that this is not an error - "it routes up automatically" - so the work
  /// order enters PENDING_APPROVAL and waits for somebody with more room.
  | { route: 'escalate'; ceilingCents: number; requestedCents: number }
  /// This actor may not approve work orders at ANY amount (a zero ceiling -
  /// a maintenance tech). Distinct from escalate because a tech should not be
  /// generating approval requests for the owner every time they open a work
  /// order; somebody who can approve has to ask.
  | { route: 'not_permitted'; reason: string }

/**
 * Combines the two questions in the only order that is correct.
 *
 * `authority` is the result of `checkMonetaryAuthority(actor,
 * 'approve_work_order', amountCents)` - passed in rather than computed here
 * so this stays pure and so the caller cannot accidentally ask about a
 * different action.
 */
export function approvalRoute(
  approvalNeeded: boolean,
  authority: AuthorityDecision,
): ApprovalRoute {
  // The money question first. An actor with a zero ceiling can still create
  // and dispatch a $40 work order, and asking about their authority before
  // asking whether authority is even required would stop them.
  if (!approvalNeeded) return { route: 'no_approval_needed' }

  switch (authority.outcome) {
    case 'allowed':
      return { route: 'self_approve' }
    case 'escalate':
      return {
        route: 'escalate',
        ceilingCents: authority.ceilingCents,
        requestedCents: authority.requestedCents,
      }
    case 'denied':
      return { route: 'not_permitted', reason: authority.reason }
  }
}

interface Violation {
  field: string
  message: string
}

export const APPROVAL_DECISIONS = ['APPROVE', 'DENY', 'ASK'] as const
export type ApprovalDecisionValue = (typeof APPROVAL_DECISIONS)[number]

export function isApprovalDecision(value: string): value is ApprovalDecisionValue {
  return (APPROVAL_DECISIONS as readonly string[]).includes(value)
}

export interface ApprovalDecisionInput {
  decision: string
  /// Required on a denial (ROLE-03, and common sense): a denial with no
  /// stated reason is indistinguishable from a mistake, and the PM needs to
  /// know whether to re-scope the job or drop it.
  denialReason?: string | null
  /// Required on an "ask" - the whole content of the action is the question.
  question?: string | null
}

export function validateApprovalDecision(input: ApprovalDecisionInput): Violation[] {
  if (!isApprovalDecision(input.decision)) {
    return [{ field: 'decision', message: 'Choose approve, deny, or ask a question.' }]
  }
  if (input.decision === 'DENY' && !input.denialReason?.trim()) {
    return [{ field: 'denialReason', message: 'Say why, so the job can be re-scoped or dropped.' }]
  }
  if (input.decision === 'ASK' && !input.question?.trim()) {
    return [{ field: 'question', message: 'Type the question you want answered.' }]
  }
  return []
}

// ---------------------------------------------------------------------------
// Bid collection (MAINT-04's fourth criterion, R-026)
// ---------------------------------------------------------------------------

export interface BidInput {
  /// Whole cents. Null when the vendor is declining rather than quoting.
  amountCents?: number | null
  note?: string | null
  declined?: boolean
}

export function validateBid(input: BidInput): Violation[] {
  if (input.declined) return []
  if (input.amountCents == null) {
    return [{ field: 'amountCents', message: 'Enter your price, or tell us you are not bidding.' }]
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
    return [{ field: 'amountCents', message: 'Enter a whole-dollar amount of $0 or more.' }]
  }
  return []
}

export interface BidSummary {
  vendorId: string
  vendorName: string
  amountCents: number | null
  declinedAt: Date | null
  respondedAt: Date | null
}

export interface BidComparison {
  bids: readonly BidSummary[]
  /// The cheapest QUOTE. Null until at least one vendor actually quotes -
  /// a declined bid is not a cheap one.
  lowestCents: number | null
  quotedCount: number
  outstandingCount: number
  /// MAINT-04's policy is "collect 2-3 bids", so the comparison is only
  /// really a comparison once two real prices are in. Surfaced rather than
  /// enforced: an owner who wants to accept the only quote that came back is
  /// allowed to, they should just be told what they are doing.
  enoughToCompare: boolean
}

/// Sorts quotes cheapest-first, then declines, then anyone still silent -
/// the order a PM reads them in.
export function compareBids(bids: readonly BidSummary[]): BidComparison {
  const quotes = bids.filter((b) => b.amountCents != null && !b.declinedAt)
  const sorted = [...bids].sort((a, b) => {
    const rank = (bid: BidSummary) =>
      bid.amountCents != null && !bid.declinedAt ? 0 : bid.declinedAt ? 1 : 2
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return (a.amountCents ?? 0) - (b.amountCents ?? 0)
  })

  return {
    bids: sorted,
    lowestCents: quotes.length > 0 ? Math.min(...quotes.map((q) => q.amountCents!)) : null,
    quotedCount: quotes.length,
    outstandingCount: bids.filter((b) => b.respondedAt == null).length,
    enoughToCompare: quotes.length >= 2,
  }
}
