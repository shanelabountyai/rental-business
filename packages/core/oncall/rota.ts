// After-hours routing: who gets paged, in what order (MAINT-12, NOTIF-05,
// R-029).
//
// THIS FILE REPLACES A DELIBERATE OVER-PAGE. R-020 shipped
// `onCallStaffForProperty()` returning EVERYONE holding `ticket.write` on
// the property, with its own comment naming this item as the replacement.
// R-026 then found that behaviour was making an emergency submit exceed 30
// seconds and recorded, correctly, that capping recipients would be "a
// safety regression dressed as a performance fix" - because paging one
// person too few during a gas leak is not symmetrical with paging one too
// many.
//
// So the narrowing here is NOT a cap. It is a rota: when somebody has
// actually been put on call, page them instead of everybody. When NOBODY
// is on call - the rota lapsed, nobody set it up, it is a two-person
// operation that never bothered - it falls back to paging everyone, because
// the one genuinely unacceptable outcome is a 3am gas leak that reaches
// nobody. Narrowing is earned by somebody taking responsibility, never
// assumed.

export interface OnCallCandidate {
  id: string
  email: string
  phone: string | null
  onCallFrom: Date | null
  onCallUntil: Date | null
}

/// The shifts the on-call button offers. Deliberately short: a shift you
/// cannot remember the end of is one you stop trusting.
///
/// Lives here rather than beside the action because a `'use server'` module
/// may only export async functions - a const export there compiles, lints,
/// typechecks, and fails at `next build` (the lesson R-025 learned the hard
/// way).
export const ON_CALL_SHIFT_HOURS = [12, 24, 72] as const

export function isOnCall(candidate: OnCallCandidate, now: Date): boolean {
  // BOTH ends required. A half-configured window (a start with no end) is
  // ambiguous, and reading it as "on call forever" is how somebody gets
  // paged at 3am for a month after covering one weekend.
  if (!candidate.onCallFrom || !candidate.onCallUntil) return false
  return candidate.onCallFrom <= now && now <= candidate.onCallUntil
}

// Deterministic, and nothing more. There is deliberately NO priority column
// behind this: every recipient in a set is paged at the same moment, so an
// ordering would change the order of a list nobody reads sequentially. A
// ranked chain is worth building the day escalation becomes tiered - page
// tier one, wait, then tier two - and not before, because a rank that
// changes nothing is a field somebody will maintain believing it does.
function byEmail(a: OnCallCandidate, b: OnCallCandidate): number {
  return a.email.localeCompare(b.email)
}

export interface PagingPlan {
  /// Who to page RIGHT NOW.
  recipients: OnCallCandidate[]
  /// Why this set - carried into the audit trail, because "who was paged
  /// and why them" is the question after an incident nobody answered.
  basis: 'on_call_rota' | 'no_rota_paging_everyone'
  /// Everyone who could be escalated to later, excluding whoever is already
  /// being paged.
  escalationChain: OnCallCandidate[]
}

/**
 * Who to page for an emergency at this property, right now.
 *
 * `candidates` is everyone with authority over the property (the caller
 * resolves that - it is a permissions question, not a rota one).
 */
export function pagingPlan(
  candidates: readonly OnCallCandidate[],
  now: Date,
): PagingPlan {
  const sorted = [...candidates].sort(byEmail)
  const onCall = sorted.filter((candidate) => isOnCall(candidate, now))

  if (onCall.length === 0) {
    // The safety fallback. Loud in the basis so it shows up in the trail
    // and in reporting as a gap somebody should close, rather than looking
    // like a working rota.
    return {
      recipients: sorted,
      basis: 'no_rota_paging_everyone',
      escalationChain: [],
    }
  }

  return {
    recipients: onCall,
    basis: 'on_call_rota',
    // Everyone else - who NOTIF-05's 15-minute unacknowledged escalation
    // reaches next. Includes the owner, which is the escalation that
    // requirement actually names.
    escalationChain: sorted.filter(
      (candidate) => !onCall.some((person) => person.id === candidate.id),
    ),
  }
}

/// NOTIF-05: "emergency ticket unacknowledged 15 min -> escalate past
/// on-call to owner".
///
/// ponytail: one constant, not per-property config. Fifteen minutes is
/// NOTIF-05's own number and it is a human-attention threshold, not a
/// jurisdiction-dependent one - no statute says how long an operator may
/// take to notice a page. Promote it the first time somebody wants a
/// different number.
export const ESCALATE_AFTER_MINUTES = 15

export interface EscalationState {
  createdAt: Date
  acknowledgedAt: Date | null
}

/// Whether an unacknowledged emergency has gone unanswered long enough to
/// reach past whoever was paged first.
///
/// "Only once" is NOT enforced here and deliberately has no column behind it.
/// The escalation send is keyed on (ticket, recipient) through the same
/// notification idempotency every other send in this product uses, so a sweep
/// that re-evaluates a still-unacknowledged emergency every few minutes
/// writes nothing the second time. A `lastEscalatedAt` column would be a
/// second, weaker copy of a guarantee that already exists.
export function shouldEscalate(state: EscalationState, now: Date): boolean {
  if (state.acknowledgedAt) return false
  return minutesUnacknowledged(state, now) >= ESCALATE_AFTER_MINUTES
}

export function minutesUnacknowledged(
  state: Pick<EscalationState, 'createdAt'>,
  now: Date,
): number {
  return Math.floor((now.getTime() - state.createdAt.getTime()) / 60_000)
}
