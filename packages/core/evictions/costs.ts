// What an eviction actually costs the owner (PAY-14, R-083).
//
// THESE ARE NOT LEDGER ENTRIES AND MUST NEVER BECOME ONE. `LedgerEntry` is an
// append-only projection of Stripe (D-11) - "a row that Stripe does not know
// about is a reconciliation bug", in CLAUDE.md's own words. A filing fee paid
// to a district clerk is money leaving the owner's pocket for something
// Stripe never touched and never will. It is also not a `Charge`: a charge is
// billed TO a tenant, and whether any of this is recoverable from them is a
// judgment the court makes, not this product.
//
// So this is the first owner-side outlay in the schema, and it is scoped to
// the case rather than to the property, because "what did this eviction cost
// us" is the question an owner asks at the end of one.

interface Violation {
  field: string
  message: string
}

/// A closed vocabulary in code against a free-form column - the same posture
/// `Notice.type`, `ComplianceItem.type` and `Vendor.trades` already take. A
/// county that invents a fee this product has never heard of should not need
/// a migration.
export const EVICTION_COST_TYPES = [
  'FILING',
  'SERVICE',
  'ATTORNEY',
  'WRIT',
  'LOCKOUT',
  'STORAGE',
  'CASH_FOR_KEYS',
  'OTHER',
] as const
export type EvictionCostTypeValue = (typeof EVICTION_COST_TYPES)[number]

export function isEvictionCostType(value: string): value is EvictionCostTypeValue {
  return (EVICTION_COST_TYPES as readonly string[]).includes(value)
}

export const EVICTION_COST_LABELS: Record<EvictionCostTypeValue, string> = {
  FILING: 'Court filing fee',
  SERVICE: 'Service of process',
  ATTORNEY: 'Attorney',
  WRIT: 'Writ of possession',
  LOCKOUT: 'Constable / lockout',
  STORAGE: 'Belongings storage',
  CASH_FOR_KEYS: 'Cash for keys',
  OTHER: 'Other',
}

export interface EvictionCostInput {
  type: string
  amountCents: number
  incurredOn: string
  description: string
}

export function validateEvictionCost(input: EvictionCostInput): Violation[] {
  const violations: Violation[] = []

  if (!isEvictionCostType(input.type)) {
    violations.push({ field: 'type', message: 'Choose what this cost was for.' })
  }
  // Zero is refused, not just negatives. A cost row of $0 records nothing and
  // would sit in the total looking like evidence of a fee that was waived -
  // if a fee was waived, that is a note, not a line.
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    violations.push({ field: 'amountDollars', message: 'Enter an amount greater than zero.' })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.incurredOn)) {
    violations.push({ field: 'incurredOn', message: 'Enter the date this was incurred.' })
  }
  if (!input.description.trim()) {
    violations.push({ field: 'description', message: 'Say what this was — an attorney reads this line.' })
  }

  return violations
}

export interface CostTotals {
  byType: Record<string, number>
  totalCents: number
}

export function costTotals(
  costs: readonly { type: string; amountCents: number }[],
): CostTotals {
  const byType: Record<string, number> = {}
  let totalCents = 0
  for (const cost of costs) {
    byType[cost.type] = (byType[cost.type] ?? 0) + cost.amountCents
    totalCents += cost.amountCents
  }
  return { byType, totalCents }
}

/**
 * PAY-14 lists "lost rent" alongside filing and attorney fees. It is NOT a
 * cost row and there is deliberately no way to enter one.
 *
 * What the tenant owes is already computed, from Stripe-backed rows, by
 * `statementForPeriod()` (R-052) - and the attorney packet prints that
 * statement. A hand-typed "lost rent" figure sitting next to it could only
 * ever agree with it by luck, and the two numbers disagreeing on the same
 * exhibit is worse than the second number not existing: it is the one thing
 * opposing counsel would need.
 *
 * This constant exists so that the next person to look for lost-rent entry
 * finds the reasoning instead of the gap.
 */
export const LOST_RENT_IS_DERIVED =
  'Lost rent is not entered here — it is the ledger balance, and the packet prints the statement of account.'
