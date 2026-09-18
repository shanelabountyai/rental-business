import { type BusinessDate, businessDate } from '../scheduling/local-time.ts'
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
  /// a proration, a chargeback). `rentDebts` below is that half.
  charges: readonly DatedCharge[]
  /// ONE DATED DEBT PER RENT PERIOD THE SUBSCRIPTION HAS BILLED (R-206),
  /// from `rentPeriodDebts` over the lease's projected ledger rows.
  ///
  /// Together with `charges` this is the WHOLE debit side of the balance:
  /// every `CHARGE` entry is either a `Charge` row's projection or the
  /// subscription's own rent line, and `rentPeriodDebts` is the second set.
  /// So the allocation below normally consumes the balance exactly, and the
  /// "ran out of debts" fallback stops being the ordinary case it was.
  ///
  /// Empty is a real state - a tenancy Stripe has not billed yet, or a
  /// balance moved by an `ADJUSTMENT` alone - and `nearestRentDueOn` below
  /// is the fallback for exactly that.
  rentDebts: readonly DatedCharge[]
  /// What the lease owes right now, from `balanceCents`. Negative is a
  /// credit and is a real state.
  balanceCents: Cents
  /// The property-local day the report is being run for.
  asOf: BusinessDate
  /// From the versioned JurisdictionRule for this property's state (D-4).
  /// Null when no rule is configured, which is NOT zero — see below.
  graceDays: number | null
  /// THE FALLBACK, USED ONLY WHEN `rentDebts` IS EMPTY (R-206). The most
  /// recent date ordinary rent was due, from `dueDateOnOrBefore`
  /// (`Lease.rentDueDay` / `LeasePayer.debitDay`) — the day-of-month pair
  /// `predebit.ts` already reads, in the direction that answers "how long
  /// ago". Null only when the caller has no lease to read it from.
  ///
  /// UNDERSTATES LATENESS WHEN MORE THAN ONE MONTH OF RENT IS UNPAID: it can
  /// only anchor to the MOST RECENT occurrence of a day-of-month, so it is
  /// never more than about a month in the past whatever is owed. That was
  /// the whole aging until R-206, and it is why a tenancy two months behind
  /// reported nineteen days late and emptied the `30+` bucket. It survives
  /// as the answer for a balance `rentDebts` cannot explain, where a rough
  /// date still beats none.
  nearestRentDueOn: BusinessDate | null
  /// `Lease.rentCents` - HOW BIG the fallback debt dated `nearestRentDueOn`
  /// is, so the allocation below knows how much of the balance that period's
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
  /// The NEWEST rent period the balance still sits on - what the chase
  /// ladder counts from (R-229). Null when no rent debt is owed, which
  /// includes a balance made only of fees or other charges.
  ///
  /// NOT `oldestDueOn`, and the difference is the defect R-229 fixed. The
  /// ladder read the oldest debt, and the oldest debt only ever gets older:
  /// a tenancy that stopped paying in March passed rungs 1, 5 and 15 once
  /// and was never chased again, through April, May and June, while the
  /// arrears grew. Each newly billed period that goes unpaid is a new thing
  /// to ask for, and counting from the newest one re-arms the ladder on
  /// every such period.
  newestRentDueOn: BusinessDate | null
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
 * The debt list is the charges PLUS `rentDebts` - one dated debt per rent
 * period the subscription billed - because ordinary rent mints no `Charge`
 * row and is otherwise invisible here. Without it, a balance that is
 * entirely this month's rent gets attributed to last year's charges.
 *
 * ONE DEBT PER PERIOD, NOT ONE PERIOD (R-206). Until this item the rent half
 * of the list was a single synthetic debt at `nearestRentDueOn`, and a
 * second unpaid month therefore outran the whole list: the balance fell
 * through to `newestFirst[last]`, which on a tenancy holding a paid move-in
 * proration is that proration. Worked, from the row: move-in 15 Jul 2025
 * with a $726 proration paid on time, rent $1,500, nothing paid since
 * February; at 20 May 2026 the anchor became 2025-07-15 and `daysLate` read
 * 309 rather than 49 - the R-118 defect returning through the fallback
 * branch, on the tenancy that matters most. Because `chaseRungDue` matches
 * days past grace EXACTLY against [1, 5, 15], 309 fires no rung at all, so
 * R-179's whole ladder went silent on precisely the tenancies it exists for.
 * The opposite face was equally wrong: a lease with no charge history
 * reported two unpaid months as nineteen days late and emptied the `30+`
 * bucket on a portfolio full of sixty-day arrears.
 *
 * WHICH DIRECTION IT CAN BE WRONG IN: only towards reporting a tenancy
 * NEWER than it is. Running out of debts before the balance is covered means
 * a debit this list does not carry - an `ADJUSTMENT` with no charge behind
 * it, or rent Stripe has not billed - and the oldest KNOWN debt is then the
 * anchor. It can never age a tenancy from a debt the balance cannot account
 * for, so it can never chase somebody early - which is the asymmetry that
 * matters, and R-206 narrows the fallback rather than widening it.
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
      newestRentDueOn: null,
    }
  }

  const { oldestDueOn, newestRentDueOn } = unsettled(facts)
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
      newestRentDueOn: null,
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
    newestRentDueOn,
  }
}

/**
 * The oldest debt the balance can still be sitting on, and the newest RENT
 * debt it is sitting on. Both null when there is nothing dated at all.
 *
 * Newest-first, because payments settle oldest-first: what remains owed is
 * the most recent end of the list. See the header on `delinquencyFor`.
 */
function unsettled(facts: DelinquencyFacts): {
  oldestDueOn: BusinessDate | null
  newestRentDueOn: BusinessDate | null
} {
  const rent = rentDebtsFor(facts.rentDebts, facts.nearestRentDueOn, facts.monthlyRentCents)
  const debts: DatedCharge[] = [...facts.charges, ...rent]
  if (debts.length === 0) return { oldestDueOn: null, newestRentDueOn: null }

  const { owed, unallocatedCents, newestFirst } = allocateBalance(debts, facts.balanceCents)
  // By identity, not by date: a fee charge dated on a rent due day is not
  // a rent period, and `allocateBalance` hands back the objects it was given.
  const rentDebts = new Set(rent)
  return {
    // Covered: the debt the balance ran out on. Not covered: the balance
    // outruns every debt on file - a debit neither the `Charge` table nor
    // the billed periods carry - so the oldest thing we CAN name is the
    // anchor, which understates rather than inventing a date.
    oldestDueOn:
      unallocatedCents === 0 ? owed[owed.length - 1]!.debt.dueOn : newestFirst[newestFirst.length - 1]!.dueOn,
    newestRentDueOn: owed.find(({ debt }) => rentDebts.has(debt))?.debt.dueOn ?? null,
  }
}

/**
 * Which debts a positive balance is still sitting on, and how much of each.
 *
 * Newest-first, because payments settle oldest-first (D-11): what remains
 * owed is the most recent end of the list. See the header on
 * `delinquencyFor` for why a charge row alone is not evidence of a debt.
 *
 * ONE ALLOCATION, READ BY BOTH THE AGING AND A CURE NOTICE'S DEMAND (R-194).
 * The two answer "what is still owed" about the same balance, and two copies
 * of this loop is how they would come to disagree - the R-118 defect was a
 * reader that got this allocation wrong.
 *
 * `unallocatedCents` is balance no debt on file accounts for.
 */
export function allocateBalance<T extends DatedCharge>(
  debts: readonly T[],
  balanceCents: Cents,
): { owed: { debt: T; owedCents: Cents }[]; unallocatedCents: Cents; newestFirst: T[] } {
  // Ties on the date break on amount purely so two runs over the same data
  // can never disagree.
  const newestFirst = [...debts].sort((a, b) => b.dueOn.localeCompare(a.dueOn) || b.amountCents - a.amountCents)

  const owed: { debt: T; owedCents: Cents }[] = []
  let remaining = balanceCents
  for (const debt of newestFirst) {
    if (remaining <= 0) break
    // Floored at zero: a credit dressed as a charge would otherwise walk the
    // allocation backwards and age the tenancy from further back than the
    // balance can justify. Corrections are reversing LEDGER entries (D-11),
    // so they belong in the balance, not here.
    const take = Math.min(remaining, Math.max(0, debt.amountCents))
    if (take > 0) owed.push({ debt, owedCents: take })
    remaining -= take
  }
  return { owed, unallocatedCents: Math.max(0, remaining), newestFirst }
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

// ---------------------------------------------------------------------------
// The chase ladder (PAY-06, R-179).
// ---------------------------------------------------------------------------

/**
 * How many days PAST GRACE a chase step falls on.
 *
 * ==========================================================================
 * COUNTED FROM THE END OF GRACE, NEVER FROM THE DUE DATE, and that is the
 * whole reason this is not just a list of `daysLate` values. Grace is a
 * jurisdiction fact (D-4) and it differs by state: a ladder written against
 * the due date would fire on day 1 in a state granting five days of grace,
 * which is the fair-housing exposure this module's header exists to prevent.
 * Read against grace, the same three rungs mean the same thing everywhere —
 * the day the tenant became chaseable, five days later, fifteen days later.
 *
 * A HOUSE HEURISTIC, NOT A STATUTE — the same posture `TURN_STALL_DAYS`
 * states about itself. Nothing in law says the second nudge belongs on day
 * five. There is nowhere to configure it yet; when an operator asks for
 * their own ladder this becomes JurisdictionRule-shaped or house-config
 * shaped, and the `pastGrace` gate above it stays exactly where it is either
 * way.
 * ==========================================================================
 */
export const CHASE_LADDER_DAYS: readonly number[] = [1, 5, 15]

/// What each rung is FOR, on the Task a human reads. The last rung is the one
/// that usually precedes a notice, which is why the job raises it louder.
export const CHASE_RUNG_LABELS: Record<number, string> = {
  1: 'first chase — grace has run out',
  5: 'second chase — five days past grace and nothing has arrived',
  15: 'final chase before a notice — fifteen days past grace',
}

/**
 * Days past grace, counted on the OLDEST unpaid debt, at which the ladder
 * stops being enough and somebody has to decide: a payment plan, a notice,
 * or a write-off (R-229).
 *
 * A house heuristic like the ladder itself - see `CHASE_LADDER_DAYS`. Thirty
 * days past grace is a second rent period unpaid, which is the point at
 * which a nudge has plainly not worked. The job raises it as a STANDING
 * decision, re-raised under R-191's cool-off while the balance stands, not
 * on one exact day: this is not a message to the tenant, so repeating it is
 * a queue doing its job rather than harassment.
 */
export const CHASE_DECISION_DAYS = 30

/// Whether a tenancy is past the point where the ladder alone will do.
/// False whenever grace is unknown (D-4), the same as `chaseRungDue`.
export function chaseDecisionDue(daysLate: number, graceDays: number | null): boolean {
  return graceDays != null && daysLate - graceDays >= CHASE_DECISION_DAYS
}

/**
 * The ladder rung due today, or null.
 *
 * EXACT MATCH, NOT "AT OR PAST". A rung is a day, not a threshold: `>=` would
 * make every day past the first rung a chase day, and the job standing on
 * this raises a Task each time it fires. Three nudges over a fortnight is a
 * collections ladder; fourteen is harassment with a queue behind it.
 *
 * Null whenever grace is unknown (D-4: no configured rule is never "chase
 * them") or the tenancy is still inside it.
 */
export function chaseRungDue(daysLate: number, graceDays: number | null): number | null {
  if (graceDays == null) return null
  const pastGrace = daysLate - graceDays
  if (pastGrace <= 0) return null
  return CHASE_LADDER_DAYS.includes(pastGrace) ? pastGrace : null
}

// ---------------------------------------------------------------------------
// The rent periods the subscription actually billed (R-205/R-206).
// ---------------------------------------------------------------------------

/// As much of a projected `LedgerEntry` as the derivation below reads.
export interface ProjectedChargeRow {
  type: string
  /// Null is the whole point. D-11/D-40 mint a `Charge` row for the
  /// exceptions only, so an UNLINKED `CHARGE` entry is the subscription's own
  /// rent line - one row per billed period, which is the per-period debt list
  /// this schema was said not to have.
  chargeId: string | null
  amountCents: Cents
  occurredAt: Date
}

/**
 * One dated debt per rent period the subscription has billed.
 *
 * ==========================================================================
 * WHY `occurredAt` IS THE DUE DATE, WITH NO SNAPPING (R-205).
 *
 * `occurredAt` is the `invoice.finalized` instant, and Stripe finalizes a
 * subscription invoice at the billing cycle anchor - which
 * `billingCycleAnchor` deliberately places at 09:00 PROPERTY-LOCAL on the
 * lease's rent due day, for exactly this class of reason (see its own
 * comment: an anchor at 00:00 lands on the previous calendar day for anybody
 * reading it slightly west). So `businessDate(occurredAt, zone)` IS the due
 * day, with nine hours of slack behind it and fifteen in front.
 *
 * Snapping the result to `dueDateOnOrBefore(day, rentDueDay)` was considered
 * and rejected: when the payer's `debitDay` differs from the day the
 * subscription is anchored on, snapping backwards names a due date up to a
 * month OLDER than the invoice - and ageing a debt older than it is, is the
 * one direction this module must never move in (see `delinquencyFor`'s
 * asymmetry note). An event delayed past midnight names a due date a day
 * LATE, which understates, which is the safe half.
 *
 * A voided invoice's REVERSAL is NOT netted off the period it retracts. The
 * gross debt therefore stays in the list while the balance no longer carries
 * it, so the allocation runs out on a NEWER debt - understating again, by
 * construction.
 * ==========================================================================
 */
export function rentPeriodDebts(
  rows: readonly ProjectedChargeRow[],
  timeZone: string,
): DatedCharge[] {
  const byDueOn = new Map<BusinessDate, Cents>()
  for (const row of rows) {
    if (row.type !== 'CHARGE' || row.chargeId != null || row.amountCents <= 0) continue
    const dueOn = businessDate(row.occurredAt, timeZone)
    // Two invoices finalized on one local day are ONE period's debt: the fee
    // that answers to them is keyed on `assessedForDueOn`, so two debts
    // sharing a date would each subtract the other's fee as already assessed.
    byDueOn.set(dueOn, (byDueOn.get(dueOn) ?? 0) + row.amountCents)
  }
  return [...byDueOn].map(([dueOn, amountCents]) => ({ dueOn, amountCents }))
}

/**
 * The rent half of a debt list: the billed periods, or the one-month
 * fallback when nothing has been billed.
 *
 * ==========================================================================
 * SHARED SO THE AGING AND A CURE NOTICE'S DEMAND CANNOT DISAGREE (R-206).
 *
 * `allocateBalance` already exists for that reason and this is the other
 * half of the same argument: the two readers allocate over the same balance,
 * so a difference in which RENT DEBTS they allocate over is a notice
 * demanding a period the rent roll thinks is paid.
 *
 * The fallback fires only on an EMPTY period list, never alongside one.
 * `rentPeriodDebts` already carries the current period once the invoice has
 * finalized, so adding the synthetic debt beside it would count that month's
 * rent twice - which absorbs balance a real older debt should have taken,
 * and moves the anchor newer.
 * ==========================================================================
 */
export function rentDebtsFor(
  periods: readonly DatedCharge[],
  nearestRentDueOn: BusinessDate | null,
  monthlyRentCents: Cents,
): DatedCharge[] {
  if (periods.length > 0) return [...periods]
  if (!nearestRentDueOn) return []
  // A zero-rent tenancy is real: the debt absorbs nothing and stays in the
  // list purely as a DATE the anchor can fall back to.
  return [{ dueOn: nearestRentDueOn, amountCents: monthlyRentCents }]
}
