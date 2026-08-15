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
  openCharges: readonly OpenCharge[]
  /// What the lease owes right now, from `balanceCents`. Negative is a
  /// credit and is a real state.
  balanceCents: Cents
  /// The property-local day the report is being run for.
  asOf: BusinessDate
  /// From the versioned JurisdictionRule for this property's state (D-4).
  /// Null when no rule is configured, which is NOT zero — see below.
  graceDays: number | null
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
 * AGED FROM THE OLDEST UNPAID CHARGE, not from the balance and not from the
 * most recent one. A tenant who has paid this month's rent while March's
 * remains outstanding is five months late, not current — and taking the
 * newest charge would report exactly the opposite. The allocation order
 * (D-11) settles oldest-first for the same reason.
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

  const oldest = facts.openCharges.reduce<OpenCharge | null>(
    (found, charge) => (found == null || charge.dueOn < found.dueOn ? charge : found),
    null,
  )
  if (!oldest) {
    // Owes money with no dated charge behind it. Real — a manual adjustment,
    // an unlinked Stripe remainder — and it cannot be aged, so it is reported
    // as a balance with no age rather than as zero days late.
    return {
      balanceCents: facts.balanceCents,
      daysLate: 0,
      bucket: 'current',
      pastGrace: false,
      oldestDueOn: null,
    }
  }

  const daysLate = daysPastDue(oldest.dueOn, facts.asOf)

  return {
    balanceCents: facts.balanceCents,
    daysLate,
    bucket: bucketFor(daysLate),
    // STRICTLY GREATER THAN. A grace period of five days means the tenant has
    // five days; on day five they are still inside it, and a fee or a chase
    // on that day is a day early. This is the same off-by-one `daysPastDue`
    // was written to kill, one level up.
    pastGrace: facts.graceDays != null && daysLate > facts.graceDays,
    oldestDueOn: oldest.dueOn,
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
