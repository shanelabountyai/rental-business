// Repayment plans (PAY-08, PAY-12; R-175).
//
// ==========================================================================
// A PLAN IS A SCHEDULE, NOT A SENTENCE SOMEBODY TYPED.
//
// Before this file a repayment agreement was a `payment_plan` hold carrying
// free text — "agreed a payment plan", which is the literal example the
// collection-method refusal still offers. Nothing knew what was agreed, when
// the instalments fell, whether any of them arrived, or that the tenancy had
// stopped keeping to it. The hold simply stayed on, and the chase and the
// late-fee meter stayed off, for as long as nobody happened to look.
//
// So the schedule is the record, and the hold hangs off it rather than the
// other way round.
// ==========================================================================
//
// This module decides nothing about money movement. It takes a schedule, a
// total received, and a date, and says whether the plan is being kept. What
// counts as "received" is the app's question (see lib/payments/plans.ts),
// because only the app can read the ledger.

import { type Cents, allocate, assertCents } from '../money/money.ts'
import { type BusinessDate, addBusinessDays, dueDateInMonth } from '../scheduling/local-time.ts'

/**
 * How long after an instalment date the plan is still being kept.
 *
 * A CONSTANT, NOT A COLUMN AND NOT A JURISDICTION RULE. It is neither a
 * statutory grace period (D-4's `graceDays` governs rent, and a repayment
 * instalment is not rent) nor a term anybody negotiates — it is the slack
 * between a tenant posting a money order and the ledger showing it. Three
 * days is that slack. If an operator ever needs to negotiate it, it becomes
 * a column on the plan; until somebody asks, a column is a value that never
 * changes with a settings screen attached.
 */
export const PLAN_GRACE_DAYS = 3

/// Longest schedule the product will write. Not a legal limit — a guard on
/// a mistyped "24" that was meant to be "2.4". Two years of instalments is
/// already far outside what a small operator runs.
export const MAX_PLAN_INSTALMENTS = 24

export const PAYMENT_PLAN_STATUSES = ['ACTIVE', 'COMPLETED', 'BROKEN', 'CANCELLED'] as const
export type PaymentPlanStatus = (typeof PAYMENT_PLAN_STATUSES)[number]

export interface PlanInstalment {
  dueOn: BusinessDate
  amountCents: Cents
}

/// Not exported: same shape as every other module's local Violation. See
/// packages/core/units/validate.ts for why this is never re-exported.
interface Violation {
  field: string
  message: string
}

export interface PlanTerms {
  totalCents: Cents
  count: number
  firstDueOn: BusinessDate
}

export function validatePlanTerms(terms: PlanTerms): Violation[] {
  const violations: Violation[] = []

  if (!Number.isInteger(terms.totalCents) || terms.totalCents <= 0) {
    violations.push({
      field: 'totalCents',
      message: 'A plan has to repay something. Enter the amount it covers.',
    })
  }
  if (!Number.isInteger(terms.count) || terms.count < 1) {
    violations.push({ field: 'count', message: 'A plan needs at least one instalment.' })
  } else if (terms.count > MAX_PLAN_INSTALMENTS) {
    violations.push({
      field: 'count',
      message: `${MAX_PLAN_INSTALMENTS} instalments is the most this will write.`,
    })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(terms.firstDueOn)) {
    violations.push({ field: 'firstDueOn', message: 'Give the date the first instalment is due.' })
  }

  return violations
}

/**
 * A monthly schedule from a total, a count and a first date.
 *
 * SPLIT WITH `allocate`, NEVER WITH DIVISION AND A ROUNDED LAST ROW. The
 * instalments sum to the total exactly, and the odd cents land on the
 * earliest instalments — which is also the direction an operator would
 * choose, since the money arrives sooner.
 *
 * Months step through `dueDateInMonth` carrying the ORIGINAL day of month,
 * not the clamped one: a plan whose first instalment falls on the 31st is due
 * on the 28th in February and back on the 31st in March, which is what "the
 * last day of the month" means to everybody who has ever agreed one.
 */
export function monthlyInstalments(terms: PlanTerms): PlanInstalment[] {
  const violations = validatePlanTerms(terms)
  if (violations.length > 0) throw new RangeError(violations[0].message)

  const amounts = allocate(terms.totalCents, Array.from({ length: terms.count }, () => 1))
  const [firstYear, firstMonth, dueDay] = terms.firstDueOn.split('-').map(Number)

  return amounts.map((amountCents, index) => {
    const monthIndex = firstMonth - 1 + index
    const year = firstYear + Math.floor(monthIndex / 12)
    const month = (monthIndex % 12) + 1
    return { dueOn: dueDateInMonth(year, month, dueDay), amountCents }
  })
}

export interface PlanProgress {
  status: Extract<PaymentPlanStatus, 'ACTIVE' | 'COMPLETED' | 'BROKEN'>
  totalCents: Cents
  /// What the schedule says should have arrived by `asOf`, counting only
  /// instalments whose grace period has also elapsed.
  dueToDateCents: Cents
  paidCents: Cents
  /// How far short of `dueToDateCents` the tenancy is. Zero unless broken.
  shortfallCents: Cents
  /// The instalment the plan broke on — the first one the money did not
  /// reach. Null while the plan is being kept.
  missedDueOn: BusinessDate | null
  /// The next instalment still not covered, whether or not it is yet due.
  /// Null once the whole schedule is paid.
  nextDueOn: BusinessDate | null
  remainingCents: Cents
}

/**
 * Is this plan being kept?
 *
 * ==========================================================================
 * CUMULATIVE, NOT INSTALMENT-BY-INSTALMENT, AND THAT IS THE CORRECT TEST.
 *
 * `paidCents` is everything the tenancy has paid since the plan started, and
 * it is compared against everything the schedule says should have arrived by
 * now. Matching individual payments to individual instalments would invent an
 * attribution the money does not carry — a tenant who pays half in week one
 * and the rest in week three has kept the instalment, and a rule that hunts
 * for one payment of exactly the right size would say otherwise.
 *
 * `paidCents` IS NET OF THE RENT CHARGED SINCE, and this comment used to say
 * the charges cancelled (D-181, corrected by R-187). They do not. The balance
 * is `arrearsAtStart + chargesSince - paymentsSince`, and "has the balance
 * fallen as fast as the schedule promised" is `paymentsSince - chargesSince
 * >= matured` — only `arrearsAtStart` cancels. Counting gross payments made a
 * tenancy paying nothing but its ordinary rent look like one keeping a plan,
 * and six months later the plan completed itself. The netting is the app's
 * job, because only the app can read the ledger; see `paidTowardPlan` in
 * apps/web/lib/payments/plans.ts for which entry types it is made of.
 *
 * The consequence, and it is deliberate: staying on a plan means staying
 * current too. A tenant paying instalments and nothing toward the month's new
 * rent is falling behind, and now the plan says so instead of the rent roll
 * showing a growing balance beside an on-track plan. An operator who wants to
 * carry a tenancy through a lean month has the instalment amounts and the
 * schedule to do it with — that is a term to agree, not an arithmetic hole.
 * ==========================================================================
 */
export function planProgress(input: {
  instalments: readonly PlanInstalment[]
  paidCents: Cents
  asOf: BusinessDate
  graceDays?: number
}): PlanProgress {
  assertCents(input.paidCents, 'paidCents')
  const graceDays = input.graceDays ?? PLAN_GRACE_DAYS

  // Sorted here, not trusted from the caller — the same call
  // `statementLines` makes. A cumulative total read out of order is
  // arithmetically fine and completely wrong.
  const schedule = [...input.instalments].sort((a, b) => a.dueOn.localeCompare(b.dueOn))
  const totalCents = schedule.reduce((sum, row) => sum + row.amountCents, 0)

  let cumulative = 0
  let dueToDateCents = 0
  let missedDueOn: BusinessDate | null = null
  let nextDueOn: BusinessDate | null = null

  for (const instalment of schedule) {
    cumulative += instalment.amountCents
    if (nextDueOn === null && cumulative > input.paidCents) nextDueOn = instalment.dueOn

    // Matured means the whole grace window has PASSED — an instalment due
    // on the 1st with three days' slack is still being kept on the 4th and
    // is missed on the 5th. Strictly greater, so a plan is never broken on
    // the last day the money could still arrive.
    if (input.asOf > addBusinessDays(instalment.dueOn, graceDays)) {
      dueToDateCents = cumulative
      if (missedDueOn === null && cumulative > input.paidCents) missedDueOn = instalment.dueOn
    }
  }

  // COMPLETED WINS OVER BROKEN. A tenancy that has paid the whole schedule
  // has finished the plan whether or not one instalment arrived late, and
  // breaking a plan that is fully paid would resume the chase against a debt
  // that no longer exists.
  if (input.paidCents >= totalCents) {
    return {
      status: 'COMPLETED',
      totalCents,
      dueToDateCents,
      paidCents: input.paidCents,
      shortfallCents: 0,
      missedDueOn: null,
      nextDueOn: null,
      remainingCents: 0,
    }
  }

  const shortfallCents = Math.max(0, dueToDateCents - input.paidCents)

  return {
    status: shortfallCents > 0 ? 'BROKEN' : 'ACTIVE',
    totalCents,
    dueToDateCents,
    paidCents: input.paidCents,
    shortfallCents,
    missedDueOn: shortfallCents > 0 ? missedDueOn : null,
    nextDueOn,
    remainingCents: totalCents - input.paidCents,
  }
}
