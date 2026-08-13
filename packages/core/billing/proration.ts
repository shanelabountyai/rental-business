import { type Cents, type ProrationMethod, prorateRent } from '../money/money.ts'
import { type BusinessDate, businessDate } from '../scheduling/local-time.ts'

// The move-in proration (PAY-08, R-042; D-12, D-3). Pure - no database, no SDK.
//
// D-12 SAYS THIS IS OURS AND NOT STRIPE'S, and the reason is not ideology.
// Stripe's proration is built for mid-cycle PLAN CHANGES: it divides by the
// seconds in the billing period and answers "how much of this subscription
// did they consume". A move-in on a calendar rent is a different question -
// "how many DAYS of this month did they live here" - and a lease answers it
// with a daily rate the tenant can check against their own calendar. The two
// agree by coincidence and disagree by a few dollars whenever a month is not
// 30 days, which is nine months in twelve.
//
// R-036 recorded `firstPeriodPartial` and deliberately went no further,
// leaving a comment that R-042 owns the amount so a later item could not
// silently skip it. This is that.
//
// PAY-08 also requires the method to be VISIBLE on the tenant ledger, which
// is why `describeProration` exists and why the caller is expected to put its
// output on the charge. "Rent $1,500 x 12/31 days" is a sentence a tenant can
// check; "Proration" is one they have to take on trust.

export interface ProrationInput {
  monthlyRentCents: Cents
  /// The day the tenant takes occupancy, property-local.
  startsOn: BusinessDate
  /// The day the FIRST full period begins - the next rent due day after
  /// move-in. The proration covers `startsOn` up to but not including this.
  firstFullPeriodStartsOn: BusinessDate
  method: ProrationMethod
}

export interface ProrationResult {
  amountCents: Cents
  daysOccupied: number
  daysInMonth: number
  method: ProrationMethod
  /// The arithmetic, in words, for the ledger and the invoice line.
  description: string
}

/**
 * What the tenant owes for the partial first month.
 *
 * Returns null when there is nothing to prorate - a lease starting exactly on
 * the rent due day owes a whole month, and inventing a zero-amount charge for
 * it would put a meaningless line on the tenant's first invoice.
 */
export function moveInProration(input: ProrationInput): ProrationResult | null {
  const start = parseBusinessDate(input.startsOn)
  const nextPeriod = parseBusinessDate(input.firstFullPeriodStartsOn)

  const daysOccupied = daysBetween(start, nextPeriod)
  if (daysOccupied <= 0) return null

  // THE DIVISOR IS THE MOVE-IN MONTH'S OWN LENGTH, not the length of the
  // period being covered. A tenant moving in on 20 February for a 1 March
  // anchor occupies 9 days of a 28-day month and owes 9/28 of the rent - not
  // 9/9, and not 9/31. Getting this wrong is the difference between a third
  // of a month's rent and all of it.
  const daysInMonth = daysInMonthOf(start)

  // A move-in that spans more days than its own month is not a proration; it
  // is a lease whose first period is longer than a month, which this function
  // has no opinion about and must not silently truncate.
  if (daysOccupied > daysInMonth) return null

  const amountCents = prorateRent({
    monthlyRentCents: input.monthlyRentCents,
    daysOccupied,
    daysInMonth,
    method: input.method,
  })

  return {
    amountCents,
    daysOccupied,
    daysInMonth,
    method: input.method,
    description: describeProration({
      monthlyRentCents: input.monthlyRentCents,
      daysOccupied,
      daysInMonth,
      method: input.method,
      amountCents,
    }),
  }
}

/**
 * The arithmetic in words.
 *
 * PAY-08 requires the method to be visible on the ledger. A tenant who can
 * see "$1,500.00 x 12/31 days" can check it against a calendar; one who sees
 * "Proration $580.65" has to take it on trust, and the first question in
 * every move-in dispute is how the number was reached.
 */
export function describeProration(input: {
  monthlyRentCents: Cents
  daysOccupied: number
  daysInMonth: number
  method: ProrationMethod
  amountCents: Cents
}): string {
  const divisor = input.method === 'banker30' ? 30 : input.daysInMonth
  const basis =
    input.method === 'banker30'
      ? `${input.daysOccupied}/30 days (30-day month)`
      : `${input.daysOccupied}/${input.daysInMonth} days`
  return `Part month — ${formatDollars(input.monthlyRentCents)} × ${basis} = ${formatDollars(input.amountCents)}`
}

/// Days from `from` up to but NOT including `to`. Half-open on purpose: a
/// tenant moving in on the 20th with a 1st anchor occupies the 20th through
/// the 31st, and the 1st belongs to the next period they are separately
/// charged a full month for. Counting it twice is the classic proration bug.
function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

function daysInMonthOf(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
}

/// `YYYY-MM-DD` at UTC midnight. These are calendar days, never instants -
/// the same BusinessDate discipline the rest of the product uses, and the
/// reason `daysBetween` can be plain arithmetic rather than timezone-aware.
function parseBusinessDate(value: BusinessDate): Date {
  return new Date(`${value}T00:00:00.000Z`)
}

/// Re-exported so a caller computing a BusinessDate for this does not have to
/// reach past this module for it.
export { businessDate }

function formatDollars(cents: Cents): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
