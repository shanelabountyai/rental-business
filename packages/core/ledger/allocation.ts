// Payment allocation (PAY-03, D-4, D-12). Pure - no database, no Stripe.
//
// WHEN A TENANT PAYS LESS THAN THEY OWE, WHICH DEBT DOES IT PAY OFF?
// The answer is a statute in several states, and it is not a detail: applying
// a partial payment to fees before rent leaves rent unpaid, which is what a
// pay-or-quit notice is served on. Get the order backwards and you serve an
// eviction notice on a tenant who paid their rent - which in several states
// also voids the notice, because accepting rent after serving it does.
//
// So the order comes from `JurisdictionRule.paymentAllocationOrder` (R-010),
// never from a constant here. This module only applies whatever order it is
// handed, oldest debt first within each category.

import { type Cents, assertCents } from '../money/money.ts'

export interface OutstandingCharge {
  id: string
  /// A `ChargeType` value. Matched against the jurisdiction's ordering by
  /// name; a type the order does not mention sorts last (see below).
  type: string
  /// What is still unpaid on this charge, in cents. Always > 0 for anything
  /// passed in - a settled charge is not outstanding.
  outstandingCents: Cents
  /// Property-local `YYYY-MM-DD`. Ties within a category break on this,
  /// oldest first.
  dueOn: string
}

export interface Application {
  chargeId: string
  appliedCents: Cents
}

export interface AllocationResult {
  applications: Application[]
  /// Money left after every outstanding charge is settled. A credit on the
  /// account, not an error - a tenant who overpays has a credit balance, and
  /// silently swallowing it would lose their money.
  unappliedCents: Cents
}

/**
 * Applies a payment across outstanding charges in the jurisdiction's order.
 *
 * `order` is a list of `ChargeType` names, most-senior first - the statutory
 * "rent before fees" where a state says so. Anything not named sorts AFTER
 * everything named, because a jurisdiction that bothered to list types was
 * being specific about those; an unlisted type is not silently promoted
 * ahead of one somebody legislated about.
 *
 * Within a category, oldest due date first. That is the universally
 * defensible tiebreak: paying the oldest debt down first is what any
 * reasonable reading of "applied to the account" means, and it is what keeps
 * `daysPastDue` from growing on a charge while newer ones get settled.
 */
export function allocatePayment(
  paymentCents: Cents,
  charges: readonly OutstandingCharge[],
  order: readonly string[],
): AllocationResult {
  assertCents(paymentCents, 'paymentCents')
  if (paymentCents < 0) {
    throw new RangeError('A payment cannot be negative - a refund is its own event')
  }

  const rank = new Map<string, number>()
  order.forEach((type, index) => rank.set(type, index))
  // Unlisted types sort after every listed one, and keep a stable order
  // among themselves.
  const rankOf = (type: string) => rank.get(type) ?? order.length

  const sorted = [...charges]
    .filter((charge) => charge.outstandingCents > 0)
    .sort(
      (a, b) =>
        rankOf(a.type) - rankOf(b.type) ||
        a.dueOn.localeCompare(b.dueOn) ||
        // Deterministic to the last tiebreak: these amounts are written to a
        // ledger and compared in tests, so two charges identical in type and
        // date must still allocate the same way every run.
        a.id.localeCompare(b.id),
    )

  const applications: Application[] = []
  let remaining = paymentCents

  for (const charge of sorted) {
    if (remaining <= 0) break
    const applied = Math.min(remaining, charge.outstandingCents)
    applications.push({ chargeId: charge.id, appliedCents: applied })
    remaining -= applied
  }

  return { applications, unappliedCents: remaining }
}

/**
 * The default order when a jurisdiction states none.
 *
 * RENT FIRST, deliberately, and this is the safe default rather than a
 * neutral one: applying a partial payment to rent first minimises the chance
 * of serving a pay-or-quit notice on somebody who has in fact paid their
 * rent. A jurisdiction that legislates a different order overrides this; a
 * jurisdiction that is silent gets the reading least likely to produce an
 * indefensible notice.
 */
export const DEFAULT_ALLOCATION_ORDER = [
  'RENT',
  'UTILITY',
  'RUBS_ALLOCATION',
  'PET_RENT',
  'LATE_FEE',
  'NSF_FEE',
  'CHARGEBACK',
  'LEGAL_COST',
] as const

export function allocationOrderFor(rule: { paymentAllocationOrder: string[] }): string[] {
  return rule.paymentAllocationOrder.length > 0
    ? rule.paymentAllocationOrder
    : [...DEFAULT_ALLOCATION_ORDER]
}
