import { type Cents, allocate, formatCents } from '../money/money.ts'
import type { BusinessDate } from '../scheduling/local-time.ts'

// Splitting a utility bill across units (PAY-08, R-042). Pure - no database,
// no SDK.
//
// RUBS - Ratio Utility Billing System - is how a property with one meter and
// several units passes the bill on. `allocate()` has been in core since R-002
// with a comment naming this as its purpose, tested, and with no caller. This
// is the caller.
//
// AN INVOICE ITEM, NOT A SUBSCRIPTION ITEM, and the distinction is the whole
// reason this is a separate file from `recurring.ts`. A flat utility fee is a
// term of the contract and Stripe can repeat it; a RUBS share is a different
// number every month because the bill is. D-12 governs: the amount is
// computed here, per bill, and pushed as a finished figure.
//
// ==========================================================================
// THE VACANT UNIT'S SHARE STAYS WITH THE OWNER.
//
// The weights are computed over EVERY unit at the property, and only the
// occupied ones are charged. Spreading a vacant unit's share across the
// tenants is the classic RUBS abuse - it makes a tenant's water bill go up
// because the neighbour moved out, which they can neither predict nor do
// anything about - and it is what several states' RUBS restrictions are aimed
// at. The remainder is named and returned rather than silently dropped, so
// the arithmetic on the bill still sums to the bill.
// ==========================================================================
//
// SEVERAL STATES REGULATE OR FORBID RUBS. That gate is
// `JurisdictionRule.rubsPermitted` (D-4) and it lives in the caller, because
// it is a fact about a property's state rather than about this arithmetic.

export const RUBS_METHODS = ['EQUAL', 'BEDROOMS', 'SQUARE_FEET'] as const
export type RubsMethod = (typeof RUBS_METHODS)[number]

export function isRubsMethod(value: string): value is RubsMethod {
  return (RUBS_METHODS as readonly string[]).includes(value)
}

export interface RubsUnitInput {
  unitId: string
  unitName: string
  /// The lease to charge, or null for a unit nobody is living in. A vacant
  /// unit still carries weight - it is part of the building - and its share
  /// is the owner's.
  leaseId: string | null
  bedrooms: number | null
  squareFeet: number | null
}

export interface RubsShare {
  unitId: string
  unitName: string
  leaseId: string
  weight: number
  amountCents: Cents
  /// The arithmetic, in words, for the ledger and the invoice line.
  description: string
}

export type RubsAllocation =
  | {
      ok: true
      shares: RubsShare[]
      /// What the owner absorbs: every vacant unit's share. Named, because a
      /// split that quietly adds up to less than the bill is a split somebody
      /// will eventually be asked to explain.
      landlordCents: Cents
      method: RubsMethod
      /// Every weight, in unit order, for the audit trail.
      weights: number[]
    }
  | { ok: false; error: string }

export interface RubsInput {
  amountCents: Cents
  /// What the bill is for - "Water", "Electricity". Goes on the invoice line.
  utilityLabel: string
  periodStart: BusinessDate
  periodEnd: BusinessDate
  method: RubsMethod
  units: readonly RubsUnitInput[]
}

/**
 * Split a utility bill across the units it covers.
 *
 * Refuses rather than guessing. A unit with no square footage recorded cannot
 * be split on square footage, and inventing a zero or an average would put a
 * number on a tenant's invoice that no one could defend - which for a charge
 * several states regulate is the wrong direction to be wrong in.
 */
export function allocateUtilityBill(input: RubsInput): RubsAllocation {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, error: 'The bill has to be an amount above zero.' }
  }
  if (input.units.length === 0) {
    return { ok: false, error: 'There are no units at this property to split the bill across.' }
  }
  if (input.periodEnd < input.periodStart) {
    return { ok: false, error: 'The billing period ends before it starts.' }
  }

  const weights: number[] = []
  for (const unit of input.units) {
    const weight = weightFor(unit, input.method)
    if (weight === null) {
      return {
        ok: false,
        error:
          input.method === 'BEDROOMS'
            ? `${unit.unitName} has no bedroom count recorded, so the bill cannot be split on bedrooms. Add it to the unit, or split equally.`
            : `${unit.unitName} has no square footage recorded, so the bill cannot be split on floor area. Add it to the unit, or split equally.`,
      }
    }
    weights.push(weight)
  }

  if (weights.reduce((total, weight) => total + weight, 0) <= 0) {
    return {
      ok: false,
      error: 'Every unit weighs zero, so there is no ratio to split the bill on.',
    }
  }

  // The remainder cents go to the largest fractional shares, so the parts sum
  // EXACTLY to the bill. That is `allocate`'s whole job and the reason it was
  // written before it had a caller.
  const parts = allocate(input.amountCents, weights)
  const total = weights.reduce((sum, weight) => sum + weight, 0)

  const shares: RubsShare[] = []
  let landlordCents = 0
  input.units.forEach((unit, index) => {
    const amountCents = parts[index]!
    if (!unit.leaseId) {
      landlordCents += amountCents
      return
    }
    shares.push({
      unitId: unit.unitId,
      unitName: unit.unitName,
      leaseId: unit.leaseId,
      weight: weights[index]!,
      amountCents,
      description: describeRubsShare({
        utilityLabel: input.utilityLabel,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        billCents: input.amountCents,
        method: input.method,
        weight: weights[index]!,
        totalWeight: total,
        amountCents,
      }),
    })
  })

  return { ok: true, shares, landlordCents, method: input.method, weights }
}

function weightFor(unit: RubsUnitInput, method: RubsMethod): number | null {
  if (method === 'EQUAL') return 1
  const value = method === 'BEDROOMS' ? unit.bedrooms : unit.squareFeet
  // Null is missing data and is refused. Zero is a recorded fact - a studio
  // has no bedrooms - and is a legitimate weight of nothing, which `allocate`
  // handles as long as something else weighs more.
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value < 0) return null
  return value
}

const METHOD_UNITS: Record<RubsMethod, string> = {
  EQUAL: 'units',
  BEDROOMS: 'bedrooms',
  SQUARE_FEET: 'sq ft',
}

/**
 * The arithmetic in words, on the charge itself.
 *
 * The same rule `describeProration` follows, and it matters more here: a RUBS
 * charge is a share of somebody else's bill, and the first question every
 * tenant asks is how their number was reached. "Water — $412.00 × 1,150/4,600
 * sq ft = $103.00" can be checked against the bill attached to it. "Utility
 * allocation $103.00" has to be taken on trust.
 */
export function describeRubsShare(input: {
  utilityLabel: string
  periodStart: BusinessDate
  periodEnd: BusinessDate
  billCents: Cents
  method: RubsMethod
  weight: number
  totalWeight: number
  amountCents: Cents
}): string {
  const basis =
    input.method === 'EQUAL'
      ? `÷ ${input.totalWeight} units`
      : `× ${format(input.weight)}/${format(input.totalWeight)} ${METHOD_UNITS[input.method]}`
  return (
    `${input.utilityLabel} ${input.periodStart} to ${input.periodEnd} — ` +
    `${formatCents(input.billCents)} ${basis} = ${formatCents(input.amountCents)}`
  )
}

function format(value: number): string {
  return value.toLocaleString('en-US')
}
