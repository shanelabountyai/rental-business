// Verify & close (MAINT-07, R-030). Pure - no database, no Next.js.
//
// MAINT-07, verbatim: "I verify before closing: tenant one-tap 'Was this
// resolved? Y/N' (+ rating); 'No' reopens with a flag; reopen rate per vendor
// is tracked. On close, labor/materials/invoice amounts attach to the
// property and flow to reporting and QuickBooks export mapping - work order →
// invoice → P&L is one chain, no re-keying."
//
// The backlog is blunt about why this item exists: the WO → invoice →
// property-books chain is "the specific place owners abandon software". They
// abandon it because the chain breaks at exactly one point - somebody has to
// type the invoice total a second time, into the books, and once that is
// true the two numbers drift and neither can be trusted. So the rule this
// module enforces is that the money is recorded ONCE, on the work order, and
// everything downstream reads it.

export const RATING_MIN = 1
export const RATING_MAX = 5

/// Local, not exported: validate.ts in this same folder already declares an
/// identical private `Violation`, and two `export *` barrels both exporting
/// the name would silently drop it from the barrel under ESM.
interface Violation {
  field: string
  message: string
}

export interface VerificationInput {
  /// The one-tap answer. Anything other than a definite yes or no is not an
  /// answer - see the validator.
  resolved: boolean | undefined
  rating?: number | null
  comment?: string | null
}

/**
 * A tenant's answer.
 *
 * THE RATING IS OPTIONAL AND STAYS OPTIONAL. MAINT-07 asks for "one-tap
 * 'Was this resolved? Y/N' (+ rating)" - one tap, and the rating rides
 * along. Requiring it would put a second decision between a tenant and the
 * word "yes", and the answer is what the close depends on; the rating is
 * management information. A verification flow that 40% of tenants abandon on
 * the second screen leaves the PM guessing, which is the state this replaces.
 */
export function validateVerification(input: VerificationInput): Violation[] {
  const violations: Violation[] = []

  if (typeof input.resolved !== 'boolean') {
    violations.push({ field: 'resolved', message: 'Tell us whether this is fixed.' })
  }

  if (input.rating != null) {
    if (
      !Number.isInteger(input.rating) ||
      input.rating < RATING_MIN ||
      input.rating > RATING_MAX
    ) {
      violations.push({
        field: 'rating',
        message: `Choose a rating from ${RATING_MIN} to ${RATING_MAX}.`,
      })
    }
  }

  // A "no" with no words is still a valid answer - the tenant has told us the
  // most important thing. The comment is invited, never demanded, for the
  // same reason the rating is: it is the difference between an answer and a
  // form.
  return violations
}

/// Statuses from which a tenant may be asked to verify. Before WORK_COMPLETE
/// there is nothing to verify; after CLOSED the question is settled.
export function awaitingVerification(status: string): boolean {
  return status === 'WORK_COMPLETE'
}

export interface CloseFacts {
  status: string
  /// Null when the job has no ticket, and so no tenant to ask.
  tenantId: string | null
  /// The tenant's answer for the current round, if they have given one.
  verifiedResolved: boolean | null
  actualLaborCents: number | null
  actualMaterialsCents: number | null
  invoiceCents: number | null
}

export type CloseRefusal =
  /// The work is not finished. Closing would assert it was.
  | 'not_complete'
  /// The tenant said it is NOT fixed. Closing over a "no" is the single
  /// worst outcome this item can produce - it converts a live complaint
  /// into a resolved record, which is what a tenant later shows a judge.
  | 'tenant_says_unresolved'
  /// No money recorded, and nobody said it was free. See the comment.
  | 'no_cost_recorded'

export interface CloseDecision {
  allowed: boolean
  refusal?: CloseRefusal
  /// True when the job is being closed WITHOUT a tenant answer. Permitted -
  /// a tenant who never replies must not be able to hold a work order open
  /// forever, and a job with no ticket has nobody to ask - but surfaced, so
  /// the PM knows what they are signing and the record says so afterwards.
  unverified?: boolean
}

/**
 * Whether this work order may be closed.
 *
 * `zeroCostAcknowledged` is how a genuinely free job closes: a warranty
 * callback, a five-minute fix, a vendor who never invoiced. It is a deliberate
 * statement rather than a default, because a work order closed at $0 by
 * accident is a hole in the property's cost history that nobody notices until
 * they are looking at a year of maintenance spend that is quietly wrong. The
 * PM says "this cost nothing" once; they never type a number twice.
 */
export function closeDecision(
  facts: CloseFacts,
  zeroCostAcknowledged = false,
): CloseDecision {
  // Order matters. "The tenant says it is not fixed" outranks every
  // bookkeeping concern - a missing invoice is a data-entry problem, and a
  // live complaint recorded as resolved is a legal one.
  if (facts.verifiedResolved === false) {
    return { allowed: false, refusal: 'tenant_says_unresolved' }
  }
  if (facts.status !== 'WORK_COMPLETE' && facts.status !== 'VERIFIED') {
    return { allowed: false, refusal: 'not_complete' }
  }

  const recorded =
    (facts.actualLaborCents ?? 0) +
    (facts.actualMaterialsCents ?? 0) +
    (facts.invoiceCents ?? 0)
  if (recorded === 0 && !zeroCostAcknowledged) {
    return { allowed: false, refusal: 'no_cost_recorded' }
  }

  return {
    allowed: true,
    unverified: facts.verifiedResolved !== true,
  }
}

/**
 * What the job actually cost, in integer cents.
 *
 * THE INVOICE WINS WHERE THERE IS ONE. Labour and materials are what the PM
 * or the vendor estimated as they worked; the invoice is what the business
 * is actually being asked to pay, and it is the number that has to match the
 * books. Where there is no invoice yet, the parts are the best available
 * truth. Summing all three would double-count every job whose vendor itemised
 * their own invoice, which is most of them.
 *
 * Deliberately the same rule as R-026's `actualTotalCents()` uses for the
 * re-approval check, so "what did this cost" cannot mean two different
 * numbers on two screens.
 */
export function jobCostCents(facts: {
  actualLaborCents: number | null
  actualMaterialsCents: number | null
  invoiceCents: number | null
}): number {
  if (facts.invoiceCents != null) return facts.invoiceCents
  return (facts.actualLaborCents ?? 0) + (facts.actualMaterialsCents ?? 0)
}

export interface VerificationRow {
  vendorId: string | null
  resolved: boolean
  rating: number | null
}

export interface VendorPerformance {
  vendorId: string
  /// Jobs where the tenant answered at all. The denominator is deliberately
  /// NOT "jobs dispatched": a vendor cannot be marked down for a tenant who
  /// never replied, and including silent jobs would make a vendor's rate
  /// depend mostly on how responsive their tenants happen to be.
  verified: number
  reopened: number
  /// 0-1. Null would be defensible for a vendor with no answers, but they
  /// are excluded from the list entirely instead - a 0% reopen rate off one
  /// job reads as excellence and is noise.
  reopenRate: number
  /// Mean rating across the answers that carried one, or null.
  averageRating: number | null
}

/**
 * Reopen rate per vendor (MAINT-07, and MAINT-10's "reopen rate and average
 * cost per vendor").
 *
 * `rows` come from WorkOrderVerification, whose `vendorId` was captured when
 * the tenant answered - NOT read off the work order now. That distinction is
 * the entire reason MAINT-07 says this is captured "from day one": a
 * reopened job is normally reassigned, so by the time anybody runs this
 * report the work order names whoever eventually fixed it. Attributing the
 * failure to them would be exactly backwards, and no later analysis can undo
 * it once the column has moved.
 */
export function vendorReopenRates(
  rows: readonly VerificationRow[],
  minimumAnswers = 1,
): VendorPerformance[] {
  const byVendor = new Map<string, { verified: number; reopened: number; ratings: number[] }>()

  for (const row of rows) {
    if (!row.vendorId) continue // in-house work has no vendor to rate
    const entry = byVendor.get(row.vendorId) ?? { verified: 0, reopened: 0, ratings: [] }
    entry.verified += 1
    if (!row.resolved) entry.reopened += 1
    if (row.rating != null) entry.ratings.push(row.rating)
    byVendor.set(row.vendorId, entry)
  }

  return [...byVendor.entries()]
    .filter(([, entry]) => entry.verified >= minimumAnswers)
    .map(([vendorId, entry]) => ({
      vendorId,
      verified: entry.verified,
      reopened: entry.reopened,
      reopenRate: entry.reopened / entry.verified,
      averageRating:
        entry.ratings.length === 0
          ? null
          : entry.ratings.reduce((sum, r) => sum + r, 0) / entry.ratings.length,
    }))
    // Worst first. The list exists to answer "who should I stop calling",
    // and a report you have to scroll to find the problem in is a report
    // nobody runs twice. Ties broken by volume, then id, so the order is
    // stable across runs rather than however the rows arrived.
    .sort(
      (a, b) =>
        b.reopenRate - a.reopenRate ||
        b.verified - a.verified ||
        a.vendorId.localeCompare(b.vendorId),
    )
}
