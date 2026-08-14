// The tenant's chosen debit day (PAY-02, R-039a; D-4).
//
// WHY A TENANT WOULD WANT ONE. Rent is due on the 1st; a lot of people are
// paid on the 3rd. Autopay that fires on the 1st against an empty account
// produces a failed debit, a returned-payment fee and a phone call - when
// moving the pull two days later would have worked every month. Letting the
// payer name the day is the difference between autopay that helps and
// autopay that manufactures arrears.
//
// WHY IT CANNOT BE ANY DAY. A debit after the grace period guarantees a late
// fee: the nightly assessment (R-040) reads the same jurisdiction config and
// does not care that the money was already on its way. Offering a tenant a
// choice that silently charges them for taking it would be worse than
// offering no choice at all - so the ceiling is checked here, in core, where
// the grace period already lives (D-4).

export type DebitDayRefusal =
  /// Not a day of the month a lease can bill on.
  | 'out_of_range'
  /// Later than the grace period allows, so the tenant would be charged a
  /// late fee for using the feature.
  | 'after_grace'
  /// Earlier than rent is due. Not unlawful, just money taken before it is
  /// owed - which is the landlord helping themselves early and is refused for
  /// the tenant's benefit, not ours.
  | 'before_due'

export interface DebitDayDecision {
  allowed: boolean
  refusal?: DebitDayRefusal
  /// The latest day this lease may debit without incurring a late fee.
  latestSafeDay: number
}

/**
 * May this payer debit on this day?
 *
 * `graceDays` comes from the versioned jurisdiction rule, so the answer moves
 * when a statute does rather than when somebody edits a constant.
 */
export function debitDayDecision(input: {
  debitDay: number
  rentDueDay: number
  graceDays: number
}): DebitDayDecision {
  const { debitDay, rentDueDay, graceDays } = input

  // 28, matching `rentDueDay`'s own ceiling: a debit on the 30th has no
  // equivalent in February, and every downstream anchor would have to invent
  // one.
  const latestSafeDay = Math.min(28, rentDueDay + graceDays)

  if (!Number.isInteger(debitDay) || debitDay < 1 || debitDay > 28) {
    return { allowed: false, refusal: 'out_of_range', latestSafeDay }
  }
  if (debitDay < rentDueDay) {
    return { allowed: false, refusal: 'before_due', latestSafeDay }
  }
  if (debitDay > latestSafeDay) {
    return { allowed: false, refusal: 'after_grace', latestSafeDay }
  }
  return { allowed: true, latestSafeDay }
}

/// What to tell somebody who picked a day we cannot use. Written for a
/// TENANT: it says what will happen to them, not which rule fired.
export function debitDayRefusalMessage(
  refusal: DebitDayRefusal,
  latestSafeDay: number,
): string {
  switch (refusal) {
    case 'after_grace':
      return `Rent would be late by then, and a late fee would apply. Choose day ${latestSafeDay} or earlier.`
    case 'before_due':
      return 'That is before your rent is due. Choose the day it is due, or a little after.'
    default:
      return 'Choose a day from 1 to 28 — later than that has no equivalent in February.'
  }
}
