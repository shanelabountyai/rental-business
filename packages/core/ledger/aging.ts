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

export interface DatedCharge {
  /// Property-local calendar day (D-3). Never a `Date` — see `daysPastDue`.
  dueOn: BusinessDate
  amountCents: Cents
}

export interface DelinquencyFacts {
  /// EVERY unwaived charge on the tenancy, paid or not. Which of them are
  /// still owed is worked out here, from the balance - see the header above.
  ///
  /// DOES NOT INCLUDE ORDINARY RENT. D-11/D-40 mint no monthly `Charge` for
  /// the subscription's own rent line - only for the exceptions (a late fee,
  /// a proration, a chargeback). `nearestRentDueOn` and `monthlyRentCents`
  /// below stand in for the rent debt these rows cannot see.
  charges: readonly DatedCharge[]
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
  /// UNDERSTATES LATENESS WHEN MORE THAN ONE MONTH OF RENT IS UNPAID: it can
  /// only anchor to the MOST RECENT due date, because unlinked rent balance
  /// is a single number in this schema, not one row per missed period
  /// (D-11's "no monthly Charge" decision, see `charges` above). Reporting
  /// the nearer date is still a real improvement on reporting a delinquent
  /// tenancy as current - which is what this function did before R-045 found
  /// the gap - and the limitation is stated rather than left to look more
  /// precise than it is.
  nearestRentDueOn: BusinessDate | null
  /// `Lease.rentCents` - HOW BIG the rent debt dated `nearestRentDueOn` is,
  /// so the allocation below knows how much of the balance that period's
  /// rent can account for before an older charge has to.
  ///
  /// REQUIRED, AND NOT OPTIONAL-WITH-A-DEFAULT ON PURPOSE. A caller that
  /// omitted it would leave the current period's rent absorbing nothing, so
  /// every balance would outrun the known debts and fall through to the
  /// oldest charge on file - which is precisely the R-118 defect, restored
  /// by a missing argument. Zero is a legitimate value (a zero-rent
  /// tenancy); silence is not.
  monthlyRentCents: Cents
}

export interface Delinquency {
  balanceCents: Cents
  /// Days past due of the oldest debt the balance is still sitting on.
  /// Zero when nothing is owed.
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
 * ==========================================================================
 * A CHARGE ROW IS NOT EVIDENCE THAT THE CHARGE IS STILL OWED (R-118).
 *
 * `Charge` carries `waivedAt` and nothing else - no paid marker, no settled
 * amount - because under D-11 a `Charge` is the instruction pushed to Stripe
 * and settlement comes back as ONE aggregate balance with no per-charge
 * allocation record. So "the charges still outstanding" is not a set this
 * schema can hand anybody, and a caller that filters `waivedAt: null` and
 * calls the result outstanding is filtering nothing at all.
 *
 * That is exactly how R-117's demo walk found a tenant owing this month's
 * rent reported as OVER 30 DAYS LATE, aged from a move-in proration that was
 * due in July 2025 and paid on time. `pastGrace` descends from the same
 * anchor, so an old paid charge could make a tenant chaseable on day one
 * whatever the statute allows - the precise failure this module's header
 * says it exists to prevent.
 *
 * So the anchor is ALLOCATED rather than looked up. Payments settle the
 * oldest debt first (D-11's stated allocation order, and `allocatePayment`'s
 * own tiebreak), which means whatever is still owed sits on the NEWEST
 * debts. Sort the debts newest-first, consume the balance, and the debt the
 * balance runs out on is the oldest one still contributing to it.
 *
 * The debt list is the charges PLUS the current period's rent - `rentCents`
 * dated `nearestRentDueOn` - because ordinary rent mints no `Charge` row and
 * is otherwise invisible here. Without it, a balance that is entirely this
 * month's rent gets attributed to last year's charges, which is the bug.
 *
 * WHICH DIRECTION IT CAN BE WRONG IN: only towards reporting a tenancy
 * NEWER than it is. Running out of debts before the balance is covered means
 * unlinked rent from a period this schema does not record (see
 * `nearestRentDueOn`), and the oldest KNOWN debt is then the anchor. It can
 * never age a tenancy from a debt the balance cannot account for, so it can
 * never chase somebody early - which is the asymmetry that matters.
 *
 * `nearestRentDueOn` STILL PARTICIPATES WHEN CHARGES EXIST, which is R-045's
 * fix and it survives this one. A late fee's `Charge.dueOn` is the day it
 * was ASSESSED - today - so a tenancy a month behind on rent with a fee
 * posted this morning has a charge dated today; the fee absorbs its own $50
 * of the balance and the rent debt underneath it takes the rest, so the
 * anchor is the rent due date and not this morning.
 * ==========================================================================
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

  const oldestDueOn = oldestUnsettled(facts)
  if (!oldestDueOn) {
    // Owes money with nothing dated at all - no charge, no lease to read a
    // rent due day from. Real (a manual adjustment with no charge behind it)
    // and it cannot be aged, so it is reported as a balance with no age
    // rather than as zero days late.
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

/**
 * The oldest debt the balance can still be sitting on. Null when there is
 * nothing dated to sit on at all.
 *
 * Newest-first, because payments settle oldest-first: what remains owed is
 * the most recent end of the list. See the header on `delinquencyFor`.
 */
function oldestUnsettled(facts: DelinquencyFacts): BusinessDate | null {
  const debts: DatedCharge[] = [...facts.charges]
  if (facts.nearestRentDueOn) {
    debts.push({
      dueOn: facts.nearestRentDueOn,
      // A zero-rent tenancy is real: the debt absorbs nothing and stays in
      // the list purely as a DATE the anchor can fall back to.
      amountCents: facts.monthlyRentCents,
    })
  }
  if (debts.length === 0) return null

  // Ties on the date break on amount purely so two runs over the same data
  // can never disagree - the answer is a date, so tied rows give the same
  // one either way.
  const newestFirst = debts.sort(
    (a, b) => b.dueOn.localeCompare(a.dueOn) || b.amountCents - a.amountCents,
  )

  let covered = 0
  for (const debt of newestFirst) {
    // Floored at zero: a credit dressed as a charge would otherwise walk
    // `covered` backwards and age the tenancy from further back than the
    // balance can justify. Corrections are reversing LEDGER entries (D-11),
    // so they belong in `balanceCents`, not here.
    covered += Math.max(0, debt.amountCents)
    if (covered >= facts.balanceCents) return debt.dueOn
  }
  // The balance outruns every debt on file - unlinked rent from a period
  // this schema does not record. The oldest thing we CAN name is the anchor,
  // which understates rather than inventing a date.
  return newestFirst[newestFirst.length - 1]!.dueOn
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
