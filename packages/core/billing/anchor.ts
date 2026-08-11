// The billing-cycle anchor (R-034, D-11, D-3). Pure - no database, no SDK.
//
// D-11: "a Subscription anchored to the lease's billing day in PROPERTY-LOCAL
// time (D-3 still holds - the anchor is computed locally, then expressed to
// Stripe)."
//
// WHY THIS IS ITS OWN MODULE WITH ITS OWN TESTS. Stripe's
// `billing_cycle_anchor` is a unix timestamp - an INSTANT. The lease's rent
// due day is a property-local CALENDAR DAY. Converting between them is the
// single place in this item where a plausible-looking mistake produces
// invoices dated a day early for a third of the portfolio, every month,
// silently. A property in America/Los_Angeles billing on the 1st and one in
// America/New_York billing on the 1st do not share an anchor instant, and a
// server that computed either in UTC would be wrong for both.

import { wallClockToUtc } from '../scheduling/local-time.ts'

/// Rent falls due at the start of the local day. Not midnight exactly:
/// Stripe generates the invoice AT the anchor, and an invoice timestamped
/// 00:00 lands on the previous calendar day for anybody reading it in a
/// zone even slightly west - including, in practice, a PM's own browser.
/// 09:00 local is unambiguous everywhere and is also when somebody could
/// actually act on a failure.
export const BILLING_HOUR_LOCAL = 9

/// Matches the lease form's own cap, and for the same reason: a lease billing
/// on the 30th has no due date in February, so Stripe would have to invent
/// one. Anything later than the 28th is "the last day", which is a template
/// concern rather than a number.
export const MAX_BILLING_DAY = 28

export interface AnchorInput {
  /// The lease's rent due day, 1-28.
  rentDueDay: number
  /// The property's IANA zone. Never the server's.
  timezone: string
  /// The first instant the subscription may bill from - normally the lease's
  /// activation. The anchor is the first billing day ON OR AFTER this.
  notBefore: Date
}

/**
 * The instant Stripe should use as `billing_cycle_anchor`.
 *
 * Lands on the first occurrence of the lease's due day, at 09:00
 * property-local, on or after `notBefore`. A lease activated on the 3rd that
 * bills on the 1st anchors to the 1st of NEXT month - never to a date in the
 * past, which Stripe would reject, and never by silently moving the due day
 * to the 3rd, which would quietly change the tenancy's terms.
 */
export function billingCycleAnchor(input: AnchorInput): Date {
  if (
    !Number.isInteger(input.rentDueDay) ||
    input.rentDueDay < 1 ||
    input.rentDueDay > MAX_BILLING_DAY
  ) {
    throw new RangeError(
      `A billing day must be a whole number from 1 to ${MAX_BILLING_DAY}, got ${input.rentDueDay}`,
    )
  }

  // Start from the local calendar month of `notBefore`, in the PROPERTY's
  // zone.
  //
  // Honest note on how much this line is doing: because the loop below
  // advances until the candidate clears `notBefore`, starting from the UTC
  // month instead would converge on the same answer - it would just
  // sometimes take one extra iteration. The property-zone read is here
  // because it is the correct starting point to reason about, not because a
  // test can distinguish it. What IS load-bearing, and what the tests do
  // pin down, is `wallClockToUtc` below: the anchor INSTANT differs between
  // two properties billing on the same local day, and holds its local hour
  // across a daylight-saving change.
  const parts = localPartsOf(input.notBefore, input.timezone)
  let year = parts.year
  let month = parts.month

  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = wallClockToUtc(
      `${pad4(year)}-${pad2(month)}-${pad2(input.rentDueDay)}T${pad2(BILLING_HOUR_LOCAL)}:00`,
      input.timezone,
    )
    if (candidate.getTime() >= input.notBefore.getTime()) return candidate
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  // Unreachable for any real input: the due day is capped at 28, so it
  // exists in every month, and one month forward always clears `notBefore`.
  // Throwing rather than returning a wrong instant, because a billing anchor
  // that is quietly wrong is worse than one that fails loudly.
  throw new Error('Could not find a billing anchor within three months')
}

/**
 * Whether the first billing period is a full one.
 *
 * A lease starting on the 1st and billing on the 1st owes a whole month from
 * day one. A lease starting on the 12th and billing on the 1st owes only the
 * remainder of that month first - and that partial amount is OURS to compute
 * and push as an invoice item (D-12), never Stripe's proration, which is
 * built for mid-cycle plan changes rather than move-in on a calendar rent.
 * R-042 owns the calculation; this only reports that one is needed, so a
 * later item cannot silently skip the question.
 */
export function firstPeriodIsPartial(input: {
  startsOn: Date
  rentDueDay: number
  timezone: string
}): boolean {
  return localPartsOf(input.startsOn, input.timezone).day !== input.rentDueDay
}

interface Parts {
  year: number
  month: number
  day: number
}

/// Calendar parts of an instant in a given zone. Uses Intl rather than the
/// Date getters, which are the SERVER's zone and would be wrong for every
/// property that is not in it.
function localPartsOf(instant: Date, timeZone: string): Parts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const [year, month, day] = formatter.format(instant).split('-').map(Number)
  return { year: year!, month: month!, day: day! }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}
function pad4(value: number): string {
  return String(value).padStart(4, '0')
}
