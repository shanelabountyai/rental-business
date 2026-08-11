import type { Cents } from '../money/money.ts'

// A payment that came back (PAY-02, R-039; D-4, D-12).
//
// ACH Direct Debit gives what Stripe calls "instant provisional access" and
// takes up to four business days to confirm. Everything downstream of a
// payment therefore runs, for days, on money that may not arrive.
//
// PAY-02 names the failure precisely: when the return lands, "no downstream
// action that was triggered by the provisional payment remains incorrectly in
// effect." The whole of this module exists to serve that sentence.

export type ReturnAction =
  /// The payment had already settled and moved the ledger. The credit has to
  /// come back off, or the tenant appears to have paid.
  | 'reverse'
  /// An attempt that never succeeded in the first place. Nothing was
  /// credited, so there is nothing to take back - recording the failure is
  /// the whole of the correct response.
  | 'record_failure'
  /// Already reversed. Stripe does not promise webhook order or
  /// exactly-once delivery, and reversing twice would double the balance.
  | 'ignore'

/**
 * What a failure event means, given what we already believe about the payment.
 *
 * THE SAME STRIPE EVENT MEANS TWO DIFFERENT THINGS depending on history, and
 * that is the subtlety this function exists to hold. `invoice.payment_failed`
 * arrives both when a first attempt is declined and when an ACH debit is
 * returned days after it settled. Reading only the event, the two are
 * indistinguishable; reading our own Payment row, they are obvious.
 *
 * Deliberately takes the STATUS rather than the row, so it stays pure and the
 * app layer owns the lookup.
 */
export function returnAction(existingStatus: string | null): ReturnAction {
  if (existingStatus === 'SETTLED') return 'reverse'
  if (existingStatus === 'REVERSED' || existingStatus === 'REFUNDED') return 'ignore'
  // No row at all, or one already FAILED/PENDING: nothing has been credited,
  // so nothing needs taking back.
  return 'record_failure'
}

export interface NsfFeeRule {
  /// False where the state bars a returned-payment fee outright. The owner
  /// absorbs the bank's charge and the tenant sees no fee.
  nsfFeePermitted: boolean
  /// The statutory ceiling, where the state sets one. Null means uncapped by
  /// statute - which is not the same as "charge anything", see below.
  nsfFeeMaxCents: number | null
}

export interface NsfFeeDecision {
  amountCents: Cents
  /// What the lease says the fee is, before the statute got involved. Kept
  /// for the same reason `lateFeeFor` keeps `computedCents`: every dispute
  /// about a fee starts by asking what it would have been.
  computedCents: Cents
  cappedAtCents?: Cents
  permitted: boolean
}

/**
 * The fee for a returned payment.
 *
 * D-12 in miniature: a statute can change this number, so core computes it
 * and Stripe is handed a finished amount as an invoice item. Never let Stripe
 * work out what a tenant owes.
 *
 * `leaseFeeCents` is what the lease itself provides for. A lease that is
 * silent charges nothing - the fee is a contractual term first and a
 * statutory ceiling second, and inventing one the tenant never agreed to is
 * how a fee becomes unenforceable at exactly the moment somebody needs to
 * enforce it.
 */
export function nsfFeeFor(rule: NsfFeeRule, leaseFeeCents: number | null): NsfFeeDecision {
  const computedCents = Math.max(0, leaseFeeCents ?? 0)

  if (!rule.nsfFeePermitted) {
    return { amountCents: 0, computedCents, permitted: false }
  }
  if (computedCents === 0) {
    return { amountCents: 0, computedCents, permitted: true }
  }
  if (rule.nsfFeeMaxCents != null && computedCents > rule.nsfFeeMaxCents) {
    return {
      amountCents: rule.nsfFeeMaxCents,
      computedCents,
      cappedAtCents: rule.nsfFeeMaxCents,
      permitted: true,
    }
  }
  return { amountCents: computedCents, computedCents, permitted: true }
}

/**
 * The amount a reversal contributes to the balance.
 *
 * ALWAYS THE OPPOSITE SIGN of the payment it reverses, and derived from that
 * payment rather than recomputed from the invoice. A partial payment that
 * returns must give back exactly what it gave, and an invoice total is not
 * that number.
 */
export function reversalAmountCents(settledPaymentCents: number): Cents {
  // The original payment entry was negative (it reduced what was owed), so
  // the reversal is positive. Written as an absolute rather than a negation
  // so a caller passing either sign gets the right answer - the direction is
  // this function's decision, not its caller's.
  return Math.abs(settledPaymentCents)
}
