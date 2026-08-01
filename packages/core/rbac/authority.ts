import type { Actor } from './can.ts'

// checkMonetaryAuthority() - the third function D-5 names. Same rule: no
// bypass, no branch on who the actor is.
//
// ROLE-02: "Financial ceilings per staff user (approve maintenance <= $X,
// waive fees <= $Y); over-ceiling actions route up automatically."
//
// The important word is "route up". An over-ceiling action is NOT an error -
// MAINT-04 says a $650 estimate against a $500 ceiling "enters Pending
// Approval", it does not fail. So this returns an escalation, and a caller
// that treats the result as a boolean will build the wrong flow. The return
// type is shaped to make that hard to do by accident.

export type MonetaryAction = 'approve_work_order' | 'waive_fee'

export type AuthorityDecision =
  | { outcome: 'allowed' }
  /// Within the actor's own authority is impossible, but somebody above them
  /// can approve it. The caller's job is to create that approval, not to
  /// refuse the action.
  | { outcome: 'escalate'; ceilingCents: number; requestedCents: number }
  /// No authority for this kind of action at all, at any amount. Escalation
  /// is not the answer because the actor should not be initiating it.
  | { outcome: 'denied'; reason: 'inactive' | 'no_authority' | 'invalid_amount' }

/**
 * A null ceiling means "no ceiling configured", and that reads as unlimited
 * ONLY here, where the actor already had to hold the permission to reach this
 * function. It is how the owner works: there is nobody above the owner to
 * route up to, so a ceiling on them would be a dead end rather than a control.
 *
 * Every other role seeds an explicit number, including an explicit zero for
 * roles that may not approve anything - so "unlimited" is never something a
 * role falls into by having a column left blank.
 */
export function checkMonetaryAuthority(
  actor: Actor,
  action: MonetaryAction,
  amountCents: number,
): AuthorityDecision {
  if (!actor.active) return { outcome: 'denied', reason: 'inactive' }

  // A negative or non-integer amount is a bug or an attack, never a real
  // approval. Money is integer cents everywhere (D-3).
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    return { outcome: 'denied', reason: 'invalid_amount' }
  }

  const ceilingCents =
    action === 'approve_work_order'
      ? actor.ceilings.approveWorkOrderCents
      : actor.ceilings.waiveFeeCents

  if (ceilingCents === null) return { outcome: 'allowed' }

  if (ceilingCents === 0) {
    // Distinguished from escalation on purpose: a maintenance tech with a zero
    // ceiling should not be generating approval requests for the owner every
    // time they open a work order.
    return { outcome: 'denied', reason: 'no_authority' }
  }

  if (amountCents <= ceilingCents) return { outcome: 'allowed' }

  return { outcome: 'escalate', ceilingCents, requestedCents: amountCents }
}

/**
 * The effective ceiling for a staff user: their personal override if set,
 * otherwise their role's default.
 *
 * Falls back on `null`, not on falsiness. Zero is a meaningful override -
 * "this person may approve nothing" - and `??` is what keeps it from being
 * silently replaced by the role default that a `||` would have used.
 *
 * Where a user holds several roles, the most generous ceiling wins, because
 * granting a second role is an act of adding authority. A null among them is
 * unlimited and therefore wins outright.
 */
export function effectiveCeiling(
  personalOverrideCents: number | null | undefined,
  roleDefaultsCents: readonly (number | null)[],
): number | null {
  if (personalOverrideCents !== null && personalOverrideCents !== undefined) {
    return personalOverrideCents
  }
  if (roleDefaultsCents.length === 0) return 0
  if (roleDefaultsCents.some((value) => value === null)) return null
  return Math.max(...(roleDefaultsCents as number[]))
}
