/**
 * Money and statutory-amount primitives.
 *
 * Two decisions from `docs/prds/07-decisions.md` live in this file:
 *
 * D-3  - money is integer cents everywhere. No floats in money math, ever.
 *        `0.1 + 0.2 !== 0.3` is not an acceptable rounding story for a rent
 *        ledger a judge may read.
 * D-12 - Stripe executes, core decides. Any number a statute could change -
 *        a late fee and its cap, proration, an allocation - is computed here
 *        and pushed to Stripe as an invoice item. Stripe must never generate
 *        a jurisdiction-dependent amount, because a fee Stripe invented is a
 *        fee we cannot defend.
 */

import { type BusinessDate, businessDaysBetween } from '../scheduling/local-time.ts'

/** An amount in integer cents. Negative means a credit. */
export type Cents = number

export function assertCents(value: number, label = 'amount'): asserts value is Cents {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be integer cents, received ${value}`)
  }
}

export function dollarsToCents(dollars: number): Cents {
  // Round on the way in so a UI that hands us 1850.005 cannot smuggle a
  // fractional cent into the ledger.
  return Math.round(dollars * 100)
}

export function centsToDollars(cents: Cents): number {
  assertCents(cents)
  return cents / 100
}

/** Tenant-facing formatting. One formatter, per D-10 - no ad hoc toFixed calls. */
export function formatCents(cents: Cents, currency = 'USD'): string {
  assertCents(cents)
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100)
}

/**
 * Clamp a computed fee to a jurisdiction's maximum.
 *
 * `cap` of `null` means the jurisdiction sets no maximum - which is not the
 * same as a cap of zero, and conflating the two is how a state with no cap
 * silently stops charging late fees.
 */
export function clampToStateCap(computed: Cents, cap: Cents | null): Cents {
  assertCents(computed, 'computed fee')
  if (cap === null) return computed
  assertCents(cap, 'cap')
  return Math.min(computed, cap)
}

export type ProrationMethod = 'actual' | 'banker30'

/**
 * Prorate rent for a partial month.
 *
 * `method` is configurable because leases disagree: some prorate on the actual
 * days in the month, some on a flat 30-day month. PAY-08 requires the method
 * to be visible on the tenant ledger, so it is an input here rather than a
 * constant buried in a caller.
 */
export function prorateRent(input: {
  monthlyRentCents: Cents
  daysOccupied: number
  daysInMonth: number
  method: ProrationMethod
}): Cents {
  const { monthlyRentCents, daysOccupied, daysInMonth, method } = input
  assertCents(monthlyRentCents, 'monthlyRentCents')
  if (daysOccupied < 0) throw new RangeError('daysOccupied cannot be negative')
  if (daysInMonth <= 0) throw new RangeError('daysInMonth must be positive')
  if (daysOccupied > daysInMonth) {
    throw new RangeError('daysOccupied cannot exceed daysInMonth')
  }

  const divisor = method === 'banker30' ? 30 : daysInMonth
  return Math.round((monthlyRentCents * daysOccupied) / divisor)
}

/**
 * Split an amount across weights without losing or inventing a cent.
 *
 * Used for RUBS-style utility allocation (PAY-08) and anywhere one payment or
 * bill is divided among several units. Naive per-share rounding leaks pennies;
 * this distributes the remainder to the largest fractional shares first, so
 * the parts always sum exactly to `total`.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total, 'total')
  if (weights.length === 0) throw new RangeError('weights cannot be empty')
  if (weights.some((w) => w < 0)) throw new RangeError('weights cannot be negative')

  const weightSum = weights.reduce((a, b) => a + b, 0)
  if (weightSum <= 0) throw new RangeError('weights must sum to more than zero')

  const exact = weights.map((w) => (total * w) / weightSum)
  const floors = exact.map((v) => Math.floor(v))
  let remainder = total - floors.reduce((a, b) => a + b, 0)

  // Largest fractional part wins the extra cent. Ties break on the earlier
  // index, which keeps the function deterministic - important, because these
  // amounts get written to a ledger and compared in tests.
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index)

  const result = [...floors]
  for (const { index } of order) {
    if (remainder <= 0) break
    result[index] += 1
    remainder -= 1
  }
  return result
}

/**
 * Days a charge is past due, counted from the original due date - not from
 * the last payment, and not from when anyone happened to look.
 *
 * TAKES BUSINESS DATES (`YYYY-MM-DD`), NOT `Date` OBJECTS, and that signature
 * is the whole fix. The original version took two `Date`s and read them with
 * the LOCAL getters, which is ambiguous in the one way that matters here: a
 * `@db.Date` column comes back from Prisma as UTC midnight, while `asOf` is
 * usually a real timestamp - so on a server west of UTC, a charge due today
 * reported ONE DAY PAST DUE on its own due date. That is a late fee charged
 * a day early, on every property, every month, and it is exactly the class of
 * error D-12 keeps this calculation in core to avoid. R-035 was its first
 * caller and found it before it had one.
 *
 * A `BusinessDate` is a property-local calendar day and cannot be misread -
 * see `packages/core/scheduling`, which has carried the same type since D-3
 * for the same reason.
 */
export function daysPastDue(dueOn: BusinessDate, asOf: BusinessDate): number {
  return Math.max(0, businessDaysBetween(dueOn, asOf))
}
