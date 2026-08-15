import type { BusinessDate } from '../scheduling/local-time.ts'
import { type Cents, daysPastDue } from '../money/money.ts'

// Delinquency aging — the Monday-morning report (PAY-06, RPT-02, R-044).
//
// ==========================================================================
// "HOW LATE" AND "PAST GRACE" ARE DIFFERENT QUESTIONS, AND CONFLATING THEM IS
// THE DEFECT THIS MODULE EXISTS TO PREVENT.
//
// The buckets PAY-06 asks for — 0–5, 6–15, 16–30, 30+ — are counted from the
// due date, flat, with no statute involved. They are an operational view: how
// long has this money been outstanding.
//
// "Past grace" is a LEGAL line, and it moves by jurisdiction. `graceDays`
// comes from the versioned JurisdictionRule for that property's state (D-4),
// and it is what decides whether a late fee may be charged and whether a
// tenant may be chased at all.
//
// A tenant three days past due in a state with a five-day grace period is in
// the 0–5 bucket AND NOT past grace. Sending them the reminder because they
// showed up in the first bucket is chasing somebody who is not yet late by
// the only definition that matters, which is how a rent-roll screen turns
// into a fair-housing complaint. So `bucket` and `pastGrace` are computed
// separately and never derived from one another.
// ==========================================================================

export const AGING_BUCKETS = ['current', '0-5', '6-15', '16-30', '30+'] as const
export type AgingBucket = (typeof AGING_BUCKETS)[number]

export const BUCKET_LABELS: Record<AgingBucket, string> = {
  current: 'Current',
  '0-5': '1–5 days',
  '6-15': '6–15 days',
  '16-30': '16–30 days',
  '30+': 'Over 30 days',
}

/**
 * Which bucket a number of days late falls in.
 *
 * `current` for anything not yet late, so a caller never has to decide what
 * "0 days past due" means. PAY-06 writes the first bucket as "0–5", but a
 * charge due today is not delinquent — bucketing it with a five-day-old debt
 * would put every tenant in the portfolio on the delinquency tile on the
 * first of the month.
 */
export function bucketFor(daysLate: number): AgingBucket {
  if (daysLate <= 0) return 'current'
  if (daysLate <= 5) return '0-5'
  if (daysLate <= 15) return '6-15'
  if (daysLate <= 30) return '16-30'
  return '30+'
}

export interface OpenCharge {
  /// Property-local calendar day (D-3). Never a `Date` — see `daysPastDue`.
  dueOn: BusinessDate
  amountCents: Cents
}

export interface DelinquencyFacts {
  /// Every charge still contributing to the balance, oldest first or not —
  /// order does not matter, the oldest is found here.
  ///
  /// DOES NOT INCLUDE ORDINARY RENT. D-11/D-40 mint no monthly `Charge` for
  /// the subscription's own rent line - only for the exceptions (a late fee,
  /// a proration, a chargeback). A late fee's own `dueOn` is the day it was
  /// ASSESSED, not the rent due date it was assessed on - so taking "the
  /// oldest of these alone" would find a fee dated today and report a
  /// tenant who has been delinquent for a month as current the moment the
  /// fee posts. `nearestRentDueOn` below is what corrects this.
  openCharges: readonly OpenCharge[]
  /// What the lease owes right now, from `balanceCents`. Negative is a
  /// credit and is a real state.
  balanceCents: Cents
  /// The property-local day the report is being run for.
  asOf: BusinessDate
  /// From the versioned JurisdictionRule for this property's state (D-4).
  /// Null when no rule is configured, which is NOT zero — see below.
  graceDays: number | null
  /// The most recent date ordinary rent was due, from `dueDateOnOrBefore`
  /// (`Lease.rentDueDay` / `LeasePayer.debitDay`) — the day-of-month pair
  /// `predebit.ts` already reads, in the direction that answers "how long
  /// ago". Null only when the caller has no lease to read it from.
  ///
  /// UNDERSTATES LATENESS WHEN MORE THAN ONE MONTH IS UNPAID: it can only
  /// anchor to the MOST RECENT due date, because unlinked rent balance is a
  /// single number in this schema, not one row per missed period (D-11's
  /// "no monthly Charge" decision, see `openCharges` above). Reporting the
  /// nearer date is still a real improvement on reporting a delinquent
  /// tenancy as current - which is what this function did before R-045
  /// found the gap - and the limitation is stated rather than left to look
  /// more precise than it is.
  nearestRentDueOn: BusinessDate | null
}

export interface Delinquency {
  balanceCents: Cents
  /// Days past due of the OLDEST unpaid charge. Zero when nothing is owed.
  daysLate: number
  bucket: AgingBucket
  /// Whether the statutory grace period has elapsed. `false` when no rule is
  /// configured, deliberately.
  pastGrace: boolean
  /// The due date the aging is counted from, so a screen can show it and a
  /// dispute can be argued from it.
  oldestDueOn: BusinessDate | null
}

/**
 * How late a tenancy is, and whether it is past grace.
 *
 * AGED FROM THE OLDEST DATED CHARGE, OR THE NEAREST RENT DUE DATE, WHICHEVER
 * IS EARLIER. A tenant who has paid this month's rent while March's charges
 * remain outstanding is months late, not current — and taking the newest
 * charge would report exactly the opposite. The allocation order (D-11)
 * settles oldest-first for the same reason.
 *
 * `nearestRentDueOn` MUST BE COMPARED ALONGSIDE `openCharges`, NEVER USED
 * ONLY AS A FALLBACK. A late fee's own `Charge.dueOn` is the day it was
 * assessed - always today or later than the rent it was assessed on - so a
 * tenancy with rent overdue for a month AND a fee posted this morning has an
 * open charge (the fee, dated today) and would report zero days late if the
 * fee alone decided it. Taking the EARLIER of the two is what R-045 found
 * missing here: this function used to fall back to `nearestRentDueOn` only
 * when `openCharges` was empty, which reported exactly that tenancy as
 * current the moment its fee posted.
 *
 * NO CONFIGURED RULE MEANS NOT PAST GRACE. `graceDays: null` is a state
 * nobody has set up (D-4), and the honest reading is "we do not know what the
 * law here allows", which must never resolve to "chase them". The same call
 * `assessNsfFee` and `assessLateFees` already make: no rule, no fee.
 */
export function delinquencyFor(facts: DelinquencyFacts): Delinquency {
  // A credit balance or a settled account is current whatever charges exist.
  // Checked FIRST, so a tenant who has overpaid is never reported late
  // because an old charge row is still on the books.
  if (facts.balanceCents <= 0) {
    return {
      balanceCents: facts.balanceCents,
      daysLate: 0,
      bucket: 'current',
      pastGrace: false,
      oldestDueOn: null,
    }
  }

  const candidates: BusinessDate[] = [
    ...facts.openCharges.map((charge) => charge.dueOn),
    ...(facts.nearestRentDueOn ? [facts.nearestRentDueOn] : []),
  ]
  const oldestDueOn = candidates.reduce<BusinessDate | null>(
    (found, dueOn) => (found == null || dueOn < found ? dueOn : found),
    null,
  )
  if (!oldestDueOn) {
    // Owes money with nothing dated at all - no open charge, no lease to
    // read a rent due day from. Real (a manual adjustment with no charge
    // behind it) and it cannot be aged, so it is reported as a balance with
    // no age rather than as zero days late.
    return {
      balanceCents: facts.balanceCents,
      daysLate: 0,
      bucket: 'current',
      pastGrace: false,
      oldestDueOn: null,
    }
  }

  const daysLate = daysPastDue(oldestDueOn, facts.asOf)

  return {
    balanceCents: facts.balanceCents,
    daysLate,
    bucket: bucketFor(daysLate),
    // STRICTLY GREATER THAN. A grace period of five days means the tenant has
    // five days; on day five they are still inside it, and a fee or a chase
    // on that day is a day early. This is the same off-by-one `daysPastDue`
    // was written to kill, one level up.
    pastGrace: facts.graceDays != null && daysLate > facts.graceDays,
    oldestDueOn,
  }
}

/// Totals per bucket, for the delinquency tile. Every bucket is present even
/// at zero, so a report never silently omits a column and a reader can tell
/// "nothing in 30+" from "we stopped counting".
export function agingTotals(
  rows: readonly { bucket: AgingBucket; balanceCents: Cents }[],
): Record<AgingBucket, { count: number; balanceCents: Cents }> {
  const totals = Object.fromEntries(
    AGING_BUCKETS.map((bucket) => [bucket, { count: 0, balanceCents: 0 }]),
  ) as Record<AgingBucket, { count: number; balanceCents: Cents }>

  for (const row of rows) {
    totals[row.bucket].count += 1
    totals[row.bucket].balanceCents += row.balanceCents
  }
  return totals
}
