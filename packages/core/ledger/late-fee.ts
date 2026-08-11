// Late fees (PAY-04, D-4, D-12). Pure - no database, no Stripe.
//
// D-12, verbatim: "Late-fee amount AND ITS STATE CAP CLAMP... are computed in
// core and pushed to Stripe as invoice items or subscription updates. Stripe
// has no concept of 'clamp this fee to the Texas maximum,' and a fee it
// generated is a fee we cannot defend."
//
// EVERY NUMBER HERE COMES FROM A JurisdictionRule. There is not one literal
// grace period, rate or ceiling in this file - D-4 is explicit that anything
// a statute can change is versioned, effective-dated configuration, and a
// late fee is the case the rule was written for. Texas caps residential late
// fees; California requires them to be a reasonable estimate of actual
// damages; some cities cap them lower than their state. A hardcoded 5% would
// be an illegal charge in a jurisdiction nobody remembered to check.

import { type BusinessDate } from '../scheduling/local-time.ts'
import { type Cents, assertCents, daysPastDue } from '../money/money.ts'

/// Mirrors the Prisma enum. Declared rather than imported for the same
/// bundle-weight reason packages/core/notifications/categories.ts gives.
export const LATE_FEE_TYPES = [
  'NONE',
  'FLAT',
  'PERCENT_OF_RENT',
  'DAILY',
  'FLAT_PLUS_DAILY',
] as const
export type LateFeeTypeValue = (typeof LATE_FEE_TYPES)[number]

/// The slice of a JurisdictionRule this calculation reads. A narrow input
/// rather than the whole row, so a test can state a jurisdiction in six
/// lines and so it is obvious which columns govern a fee.
export interface LateFeeRule {
  graceDays: number
  lateFeeType: string
  lateFeeFlatCents: number | null
  lateFeePercentBps: number | null
  lateFeeDailyCents: number | null
  /// The statutory ceilings. EITHER OR BOTH may apply, and both are nullable
  /// - null means "this jurisdiction sets no such maximum", which is not the
  /// same as zero. Conflating them is how a state with no cap silently stops
  /// charging late fees.
  lateFeeMaxCents: number | null
  lateFeeMaxPercentBps: number | null
}

export type LateFeeBasis =
  /// The jurisdiction charges no late fee at all.
  | 'no_fee_in_jurisdiction'
  /// Still inside the grace period.
  | 'within_grace'
  /// Nothing outstanding to charge a fee on.
  | 'nothing_owed'
  /// A fee applies.
  | 'assessed'

export interface LateFeeDecision {
  basis: LateFeeBasis
  /// Always >= 0. Zero for every basis but `assessed`.
  amountCents: Cents
  daysLate: number
  /// What the rule produced BEFORE the statutory ceiling was applied. Shown
  /// on the ledger and in the waiver report (PAY-04) because "we computed
  /// $95 and charged $50 because Texas caps it" is the sentence that
  /// defends the charge; a bare $50 does not.
  computedCents: Cents
  /// The ceiling that bound, when one did. Null when nothing clamped.
  cappedAtCents: Cents | null
  /// Which rule produced the number, for the ledger description.
  ruleSummary: string
}

export interface LateFeeFacts {
  /// What is still unpaid on the charge the fee is being assessed against.
  /// A partially-paid rent charge accrues a percentage fee on the REMAINDER,
  /// not on the original amount - charging on money already received is
  /// indefensible.
  outstandingCents: Cents
  /// The full monthly rent, which is what a percentage cap is measured
  /// against. Distinct from `outstandingCents` on purpose.
  monthlyRentCents: Cents
  dueOn: BusinessDate
  asOf: BusinessDate
}

/**
 * The late fee owed on a charge, if any.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. Grace is checked before anything is
 * computed, because a fee inside the grace period is not a small fee, it is
 * no fee. Then whether anything is actually outstanding. Only then the rate,
 * and only then the ceiling.
 *
 * Never throws for an unconfigured jurisdiction: a rule with `NONE` is a
 * complete, valid answer meaning this jurisdiction charges no late fee.
 * Refusing to compute would be indistinguishable from a bug at the call
 * site, and the caller would have to invent a fallback - which is precisely
 * how a hardcoded number gets back in.
 */
export function lateFeeFor(rule: LateFeeRule, facts: LateFeeFacts): LateFeeDecision {
  assertCents(facts.outstandingCents, 'outstandingCents')
  assertCents(facts.monthlyRentCents, 'monthlyRentCents')

  const daysLate = daysPastDue(facts.dueOn, facts.asOf)
  const none: Omit<LateFeeDecision, 'basis' | 'ruleSummary'> = {
    amountCents: 0,
    daysLate,
    computedCents: 0,
    cappedAtCents: null,
  }

  if (rule.lateFeeType === 'NONE') {
    return { ...none, basis: 'no_fee_in_jurisdiction', ruleSummary: 'No late fee in this jurisdiction' }
  }

  // STRICTLY GREATER THAN. A grace of 5 days means a fee on day 6, not day
  // 5 - the tenant is entitled to the whole grace period, and an
  // off-by-one here charges a fee a day early on every lease in the state.
  if (daysLate <= rule.graceDays) {
    return {
      ...none,
      basis: 'within_grace',
      ruleSummary: `Within the ${rule.graceDays}-day grace period`,
    }
  }

  if (facts.outstandingCents <= 0) {
    return { ...none, basis: 'nothing_owed', ruleSummary: 'Nothing outstanding' }
  }

  // Days the fee actually accrues over, for the daily rates: the grace
  // period is not chargeable, so a 5-day grace and 8 days late is 3
  // chargeable days, not 8.
  const chargeableDays = daysLate - rule.graceDays

  const computed = computeRate(rule, facts, chargeableDays)
  const ceiling = statutoryCeiling(rule, facts.monthlyRentCents)
  const amount = ceiling == null ? computed.cents : Math.min(computed.cents, ceiling)

  return {
    basis: 'assessed',
    amountCents: amount,
    daysLate,
    computedCents: computed.cents,
    cappedAtCents: ceiling != null && ceiling < computed.cents ? ceiling : null,
    ruleSummary: computed.summary,
  }
}

function computeRate(
  rule: LateFeeRule,
  facts: LateFeeFacts,
  chargeableDays: number,
): { cents: Cents; summary: string } {
  const flat = rule.lateFeeFlatCents ?? 0
  const daily = rule.lateFeeDailyCents ?? 0
  const bps = rule.lateFeePercentBps ?? 0

  switch (rule.lateFeeType as LateFeeTypeValue) {
    case 'FLAT':
      return { cents: flat, summary: 'Flat late fee' }

    case 'PERCENT_OF_RENT':
      // Of what is OUTSTANDING, not of the full rent. A tenant who paid most
      // of the rent should not be charged a percentage of the whole.
      return {
        cents: bpsOf(facts.outstandingCents, bps),
        summary: `${bps / 100}% of the outstanding balance`,
      }

    case 'DAILY':
      return {
        cents: daily * chargeableDays,
        summary: `Daily late fee × ${chargeableDays} day${chargeableDays === 1 ? '' : 's'}`,
      }

    case 'FLAT_PLUS_DAILY':
      return {
        cents: flat + daily * chargeableDays,
        summary: `Flat late fee plus a daily amount × ${chargeableDays} day${chargeableDays === 1 ? '' : 's'}`,
      }

    default:
      // An unrecognised type is a configuration error, not a licence to
      // invent a number. Zero, and the summary says so, so it shows up on
      // the ledger rather than silently becoming a fee somebody has to
      // explain later.
      return { cents: 0, summary: `Unrecognised late-fee type "${rule.lateFeeType}"` }
  }
}

/**
 * The statutory ceiling, in cents.
 *
 * A jurisdiction can express its cap as a flat amount, a percentage of rent,
 * or BOTH - and when both apply the binding one is the LOWER. Taking the
 * higher, or only reading whichever is non-null first, would charge above a
 * limit somebody wrote into a statute.
 */
export function statutoryCeiling(
  rule: Pick<LateFeeRule, 'lateFeeMaxCents' | 'lateFeeMaxPercentBps'>,
  monthlyRentCents: Cents,
): Cents | null {
  const caps: Cents[] = []
  if (rule.lateFeeMaxCents != null) caps.push(rule.lateFeeMaxCents)
  if (rule.lateFeeMaxPercentBps != null) {
    caps.push(bpsOf(monthlyRentCents, rule.lateFeeMaxPercentBps))
  }
  if (caps.length === 0) return null
  return Math.min(...caps)
}

/// Basis points of an amount, in integer cents. 500 bps = 5%.
///
/// Rounded, not truncated: truncation systematically favours the landlord by
/// up to a cent on every fee, which is both wrong and the kind of thing that
/// looks deliberate in a pattern report.
function bpsOf(amountCents: Cents, bps: number): Cents {
  return Math.round((amountCents * bps) / 10_000)
}

/**
 * What to charge TODAY, given what this overdue charge has already attracted.
 *
 * THE FUNCTION ABOVE RETURNS A CUMULATIVE FIGURE, and that is the single
 * easiest thing to get wrong about late fees on a schedule. `lateFeeFor()`
 * answers "what is the total fee owed as of this date" - correct, and exactly
 * what a DAILY or FLAT_PLUS_DAILY rule needs. Charging that number every
 * night would compound a $10/day fee into $10 on day one, $20 on day two and
 * $30 on day three: $60 owed by day three instead of $30.
 *
 * So an assessment charges the DELTA. Three consequences fall out of that,
 * and all three are the behaviour you want:
 *   - a FLAT fee charges once and then produces zero forever;
 *   - a DAILY fee charges one day's worth each day;
 *   - a fee that has hit its statutory ceiling produces zero from then on,
 *     because the cumulative figure stops moving.
 *
 * Never negative. A waiver, or a rule that got more generous between
 * assessments, leaves more already charged than the cumulative figure allows
 * - and the answer to that is to charge nothing further, not to invent a
 * credit. Reversing an over-charge is a deliberate act with a reason on it
 * (PAY-04's waiver), not an arithmetic side effect.
 */
export function lateFeeDeltaCents(
  decision: LateFeeDecision,
  alreadyAssessedCents: Cents,
): Cents {
  if (decision.basis !== 'assessed') return 0
  return Math.max(0, decision.amountCents - alreadyAssessedCents)
}
