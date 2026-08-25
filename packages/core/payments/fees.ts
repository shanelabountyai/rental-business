import type { Cents } from '../money/money.ts'

// The card pass-through fee (PAY-01; D-4, D-12).
//
// PAY-01 says card payments carry a "processing fee passed through and
// disclosed". Two things follow that the story does not say out loud, and
// both are why this is a core module rather than a number in a component:
//
// 1. WHETHER we may pass it through at all is jurisdiction-dependent, so it
//    reads from `JurisdictionRule` and never from a literal (D-4). Several
//    states restrict surcharging outright, and more of them restrict it on
//    DEBIT cards specifically while allowing it on credit - which is why the
//    rule is a three-state policy rather than the boolean R-037 shipped
//    (R-037b, D-149). A product that hardcodes "2.9% + 30c" is a product
//    that quietly breaks the law in some of its markets.
// 2. HOW MUCH it is, is arithmetic somebody will get wrong. A processor
//    takes its percentage of the amount it actually charges, not of the rent
//    underneath it, so a true pass-through has to gross up. See below.
//
// D-12's rule applies in full: core computes the number, Stripe executes it.

/**
 * Stripe's published US card pricing, and the basis of the pass-through.
 *
 * A PROCESSOR fact, not a legal one, which is why it lives here as a named
 * constant rather than on `JurisdictionRule` beside the things a statute
 * decides. If the negotiated rate ever differs from the published one, this
 * becomes entity configuration - but inventing that column before there are
 * two rates to hold would be scaffolding for a need that does not exist.
 */
export const CARD_RATE_BPS = 290
export const CARD_FIXED_CENTS = 30

/**
 * Whether the tenant may be charged the processing cost, and on which cards.
 *
 * THREE STATES, NOT A BOOLEAN, because the commonest US rule is neither
 * "yes" nor "no" (R-037b). Tex. Bus. & Com. Code §604A.003 bars a surcharge
 * on a DEBIT or stored-value card while permitting one on credit, and
 * several other states word it the same way. A boolean cannot say that, so
 * the Texas row said `true` and this product surcharged debit cards - which
 * is the defect this type exists to make unrepresentable.
 *
 *   NONE        - the state forbids surcharging outright. The owner absorbs
 *                 the cost and the tenant is shown no fee.
 *   CREDIT_ONLY - permitted on credit, barred on debit and stored-value.
 *   ALL         - permitted on any card.
 */
export type CardSurchargePolicy = 'NONE' | 'CREDIT_ONLY' | 'ALL'

/**
 * What Stripe reports as a card's funding type, plus the honest fourth value.
 *
 * `unknown` IS THE ORDINARY CASE HERE, not an error path. Stripe only knows
 * the funding type once a payment method exists, and this product quotes the
 * fee before one does - PAY-01 requires the number be disclosed BEFORE the
 * tenant chooses a rail. So `unknown` is what the pay screen and the
 * payment-intent call both pass, and `surchargePermittedFor` is where that
 * costs us rather than costing the tenant.
 */
export type CardFunding = 'credit' | 'debit' | 'prepaid' | 'unknown'

export interface CardFeeRule {
  cardSurchargePolicy: CardSurchargePolicy
  /// A statutory ceiling on the surcharge, in basis points of the amount
  /// being paid. Null where the state sets none.
  cardSurchargeMaxBps: number | null
}

/**
 * May we surcharge THIS card under THIS rule?
 *
 * The whole point is the middle branch. Under `CREDIT_ONLY` a surcharge is
 * lawful on credit and unlawful on debit, so a funding type we do not know
 * cannot be surcharged: charging and hoping it was credit is a statutory
 * violation on every debit card that comes through, and this product has no
 * way to tell afterwards. Under-collecting is a cost; over-collecting here
 * is unlawful, and only one of those two errors is ours to choose.
 *
 * `prepaid` is barred alongside `debit` deliberately - §604A.003 names
 * "debit or stored value card", and a prepaid card is the stored-value one.
 */
export function surchargePermittedFor(
  policy: CardSurchargePolicy,
  funding: CardFunding,
): boolean {
  if (policy === 'NONE') return false
  if (policy === 'ALL') return true
  return funding === 'credit'
}

export interface CardFeeDecision {
  /// What to add to the payment, in cents. Zero when surcharging is not
  /// permitted - the owner absorbs the cost.
  feeCents: Cents
  /// What the tenant's card is actually charged: the rent plus the fee.
  totalCents: Cents
  /// The funding type the decision was made against. Recorded because
  /// "why was I not charged a fee" and "why was I" are both questions this
  /// answers, and under CREDIT_ONLY the answer is usually `unknown`.
  funding: CardFunding
  /// True when a statutory cap bit. Surfaced rather than silently applied,
  /// because a capped surcharge means the owner is absorbing the remainder
  /// and that is a fact worth being able to report on.
  cappedAtCents?: Cents
  /// The uncapped, un-gated computation. Kept for the same reason
  /// `lateFeeFor` keeps `computedCents`: "what would this have been" is the
  /// question every dispute about a fee starts with.
  computedCents: Cents
  permitted: boolean
}

/**
 * What to add to a card payment of `amountCents`.
 *
 * GROSSED UP, NOT NOMINAL, and this is the part worth reading twice. A
 * processor's percentage applies to the total it charges. Charging
 * `amount + (rate x amount) + fixed` therefore does NOT recover the cost:
 * the processor takes its cut of the larger number, and the owner is left
 * short by the rate applied to the fee itself. On $1,500 that gap is about
 * $1.32 a month per tenant, which is invisible per payment and is real money
 * across a portfolio for as long as nobody notices.
 *
 *     total x (1 - rate) = amount + fixed
 *     total              = (amount + fixed) / (1 - rate)
 *     fee                = total - amount
 *
 * Rounded UP to the cent. A pass-through that rounds down is a pass-through
 * that loses a fraction of a cent every time, and rounding in the payer's
 * favour on a fee they did not have to incur - ACH is free (PAY-01) - is the
 * wrong direction to be generous in. Integer cents throughout (D-3).
 *
 * Note that this stays within card-network surcharging rules, which cap a
 * surcharge at the merchant's actual cost of acceptance: grossing up recovers
 * exactly the cost of accepting the total, and not a cent more.
 *
 * `funding` HAS NO DEFAULT, deliberately. Every call site is made to say what
 * it actually knows about the card, because a default of `unknown` would let
 * a future caller that DOES know silently forget to pass it, and a default of
 * `credit` would quietly reintroduce the exact defect R-037b closed.
 */
export function cardFeeFor(
  rule: CardFeeRule,
  amountCents: Cents,
  funding: CardFunding,
): CardFeeDecision {
  const permitted = surchargePermittedFor(rule.cardSurchargePolicy, funding)

  if (amountCents <= 0) {
    return { feeCents: 0, totalCents: amountCents, computedCents: 0, permitted, funding }
  }

  // Integer arithmetic on a rate expressed in basis points: multiply first,
  // divide once, and round up. Doing this in floating point is how a money
  // total ends in .999999 and a test asserts against the wrong cent (D-3).
  const denominatorBps = 10_000 - CARD_RATE_BPS
  const computedTotal = Math.ceil(((amountCents + CARD_FIXED_CENTS) * 10_000) / denominatorBps)
  const computedCents = computedTotal - amountCents

  if (!permitted) {
    // The owner absorbs it. The tenant is shown no fee at all rather than a
    // fee of zero, which is a UI decision the caller makes from `permitted`.
    //
    // THE CARD RAIL STAYS OPEN. Not surcharging is not the same as not
    // accepting cards, and conflating the two is what `railsFor` used to do
    // (R-037b) - a state that banned the surcharge had card payments turned
    // off altogether, which is a worse answer for the tenant than the fee
    // ever was.
    return { feeCents: 0, totalCents: amountCents, computedCents, permitted: false, funding }
  }

  const capCents =
    rule.cardSurchargeMaxBps == null
      ? null
      : Math.floor((amountCents * rule.cardSurchargeMaxBps) / 10_000)

  if (capCents != null && computedCents > capCents) {
    return {
      feeCents: capCents,
      totalCents: amountCents + capCents,
      cappedAtCents: capCents,
      computedCents,
      permitted: true,
      funding,
    }
  }

  return {
    feeCents: computedCents,
    totalCents: amountCents + computedCents,
    computedCents,
    permitted: true,
    funding,
  }
}

/**
 * The sentence a tenant sees before they choose a card.
 *
 * PAY-01 requires the fee be "disclosed", and disclosure means BEFORE the
 * choice, in money rather than a percentage. A tenant deciding between free
 * and not-free needs the actual number, and "2.9% + $0.30" is a calculation
 * they should not have to do while holding a phone.
 *
 * Returns null when there is nothing to disclose, so a caller cannot
 * accidentally render "a fee of $0.00" and teach tenants to ignore the line.
 */
export function cardFeeDisclosure(decision: CardFeeDecision, formatCents: (c: Cents) => string): string | null {
  if (!decision.permitted || decision.feeCents <= 0) return null
  return `Paying by card adds a ${formatCents(decision.feeCents)} processing fee, charging ${formatCents(decision.totalCents)} in total. Paying by bank transfer is free.`
}
