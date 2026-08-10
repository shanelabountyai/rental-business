import type { Cents } from '../money/money.ts'

// The card pass-through fee (PAY-01; D-4, D-12).
//
// PAY-01 says card payments carry a "processing fee passed through and
// disclosed". Two things follow that the story does not say out loud, and
// both are why this is a core module rather than a number in a component:
//
// 1. WHETHER we may pass it through at all is jurisdiction-dependent, so it
//    reads from `JurisdictionRule` and never from a literal (D-4). Several
//    states restrict surcharging outright, and some regulate rent
//    convenience fees specifically. A product that hardcodes "2.9% + 30c"
//    is a product that quietly breaks the law in some of its markets.
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

export interface CardFeeRule {
  /// Whether the tenant may be charged the processing cost at all. False in
  /// a jurisdiction that forbids surcharging - in which case the owner
  /// absorbs it, and the tenant is simply not shown a fee.
  cardSurchargePermitted: boolean
  /// A statutory ceiling on the surcharge, in basis points of the amount
  /// being paid. Null where the state sets none.
  cardSurchargeMaxBps: number | null
}

export interface CardFeeDecision {
  /// What to add to the payment, in cents. Zero when surcharging is not
  /// permitted - the owner absorbs the cost.
  feeCents: Cents
  /// What the tenant's card is actually charged: the rent plus the fee.
  totalCents: Cents
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
 */
export function cardFeeFor(rule: CardFeeRule, amountCents: Cents): CardFeeDecision {
  if (amountCents <= 0) {
    return { feeCents: 0, totalCents: amountCents, computedCents: 0, permitted: rule.cardSurchargePermitted }
  }

  // Integer arithmetic on a rate expressed in basis points: multiply first,
  // divide once, and round up. Doing this in floating point is how a money
  // total ends in .999999 and a test asserts against the wrong cent (D-3).
  const denominatorBps = 10_000 - CARD_RATE_BPS
  const computedTotal = Math.ceil(((amountCents + CARD_FIXED_CENTS) * 10_000) / denominatorBps)
  const computedCents = computedTotal - amountCents

  if (!rule.cardSurchargePermitted) {
    // The owner absorbs it. The tenant is shown no fee at all rather than a
    // fee of zero, which is a UI decision the caller makes from `permitted`.
    return { feeCents: 0, totalCents: amountCents, computedCents, permitted: false }
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
    }
  }

  return {
    feeCents: computedCents,
    totalCents: amountCents + computedCents,
    computedCents,
    permitted: true,
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
