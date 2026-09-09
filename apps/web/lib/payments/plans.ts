import 'server-only'

import { type PlanProgress, planProgress } from '@rental/core/payments'
import type { PaymentPlanStatus } from '@rental/core/payments'
import { type BusinessDate, businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { type Prisma, type PrismaClient, prisma } from '@rental/db'

// Reading repayment plans (PAY-08, R-175).
//
// SEPARATE FROM plan-actions.ts BECAUSE THAT FILE IS `'use server'`.
// Exporting a query from a server-action module publishes it as a
// client-callable endpoint - the same split waiver-report.ts makes, and for
// the same reason.

type Db = PrismaClient | Prisma.TransactionClient

/// The entry shape this module needs. Deliberately the same three columns
/// the rent roll already selects, so it can hand its own already-fetched
/// ledger straight in rather than paying for a second read of it.
export interface PlanLedgerRow {
  type: string
  amountCents: number
  occurredAt: Date
}

/**
 * NET progress toward the plan: what arrived, less what was charged since.
 *
 * ==========================================================================
 * THE CHARGES DO NOT CANCEL, AND D-181 SAID THEY DID (R-187).
 *
 * The balance is `arrearsAtStart + chargesSince - paymentsSince`, and the
 * plan is being kept when that balance has fallen by the matured schedule:
 *
 *     arrearsAtStart + chargesSince - paymentsSince <= arrearsAtStart - matured
 *       =>  paymentsSince - chargesSince >= matured
 *
 * The `arrearsAtStart` cancels. `chargesSince` does not, and dropping it is
 * not a rounding error - it is the difference between a plan and an amnesty.
 * A $2,400 plan of six $400 instalments, against a tenancy paying only its
 * ordinary $1,500 rent and not a cent more, read ACTIVE with a zero
 * shortfall for six months and then COMPLETED itself, while the
 * `payment_plan` hold kept the chase and the late-fee meter off for the
 * whole run - and raised a "paid in full" Task on a debt nobody had paid.
 *
 * So the arithmetic is the same three types the balance is made of, netted:
 * PAYMENT (negative), CHARGE (positive) and REVERSAL (either sign, undoing
 * one of the two). Negating that sum is exactly `paymentsSince -
 * chargesSince`, which is why a REVERSAL no longer needs classifying by what
 * it points at: a positive one takes back a payment and a negative one takes
 * back a charge, and both are already correct in the sum.
 *
 * CREDIT AND ADJUSTMENT ARE BOTH EXCLUDED, and for one reason: a plan kept
 * by a credit is a plan kept by us. D-181 gave that reason for ADJUSTMENT
 * and then counted CREDIT anyway. A concession we granted is not the tenancy
 * keeping to a schedule, whichever column it lands in.
 *
 * The list is an ALLOWLIST, not "everything except those two". A seventh
 * `LedgerEntryType` must not join this arithmetic by being added to an enum.
 * ==========================================================================
 *
 * FLOORED AT ZERO. A tenancy further behind than when the plan started has
 * made no progress on it - and the alternative reads as `remainingCents`
 * exceeding the plan total on the panel, which is a second, differently
 * scoped statement of the balance the rent roll already shows. The floor is
 * applied to the total, never per period, so a bad month followed by a
 * catch-up still counts in full.
 *
 * `until` bounds the window for a plan that has already ENDED: what had
 * arrived at the instant the sweep called it, not what the ledger says
 * today. Without it every completed plan eventually reads as unpaid again,
 * because next month's rent is another charge inside an open-ended window.
 * Left undefined for a live plan, where now is the right question.
 *
 * `startedOn` is a calendar day in the property's zone and `occurredAt` is a
 * real timestamp, so the lower bound goes through `businessDate` - the R-042
 * rule, in the direction that is correct for a timestamp. The upper bound is
 * an instant compared with an instant, so no zone touches it.
 */
export function paidTowardPlan(
  entries: readonly PlanLedgerRow[],
  startedOn: BusinessDate,
  timezone: string,
  until?: Date | null,
): number {
  let net = 0
  for (const entry of entries) {
    if (entry.type !== 'PAYMENT' && entry.type !== 'CHARGE' && entry.type !== 'REVERSAL') continue
    if (businessDate(entry.occurredAt, timezone) < startedOn) continue
    if (until && entry.occurredAt > until) continue
    net += entry.amountCents
  }
  // Negated: a payment reduces what is owed, and "paid" is a positive number
  // everywhere it is read.
  return Math.max(0, -net)
}

const PLAN_SELECT = {
  id: true,
  leaseId: true,
  propertyId: true,
  status: true,
  arrearsCents: true,
  startedOn: true,
  note: true,
  createdAt: true,
  brokenAt: true,
  brokenOn: true,
  completedAt: true,
  cancelledAt: true,
  cancelReason: true,
  createdBy: { select: { name: true } },
  cancelledBy: { select: { name: true } },
  instalments: {
    select: { id: true, sequence: true, dueOn: true, amountCents: true },
    orderBy: { sequence: 'asc' },
  },
  hold: { select: { id: true, liftedAt: true } },
} as const

/// The fetched row, exported so a bulk caller that already holds the ledger
/// can compute progress itself rather than paying for a second read of it.
export type PlanRecord = Prisma.PaymentPlanGetPayload<{ select: typeof PLAN_SELECT }>

export interface PlanInstalmentView {
  id: string
  sequence: number
  dueOn: BusinessDate
  amountCents: number
}

export interface PlanView {
  id: string
  leaseId: string
  status: PaymentPlanStatus
  arrearsCents: number
  startedOn: BusinessDate
  note: string
  instalments: PlanInstalmentView[]
  /// Computed fresh from the ledger every time this is read, never stored.
  /// The stored `status` is what the nightly sweep last decided; for a LIVE
  /// plan this is what is true right now, and a screen showing the stored one
  /// would be up to a day stale on the only question anybody opens it to ask.
  /// For an ENDED plan it is measured at the instant the plan ended, so
  /// `status === 'COMPLETED'` with a non-zero `remainingCents` is a plan the
  /// record says was paid off and the ledger cannot support (R-187).
  progress: PlanProgress
  createdAt: Date
  createdByName: string
  brokenAt: Date | null
  brokenOn: BusinessDate | null
  completedAt: Date | null
  cancelledAt: Date | null
  cancelledByName: string | null
  cancelReason: string | null
  /// The hold this plan placed, and whether it is still in force.
  holdInForce: boolean
}

/** Turns a fetched plan and the lease's ledger into a view. */
export function toPlanView(
  plan: PlanRecord,
  entries: readonly PlanLedgerRow[],
  timezone: string,
  today: BusinessDate,
): PlanView {
  const startedOn = utcToBusinessDate(plan.startedOn)
  const instalments = plan.instalments.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    // `@db.Date`. Read with `utcToBusinessDate`; putting a calendar day
    // through a timezone is the R-042 bug in a new place.
    dueOn: utcToBusinessDate(row.dueOn),
    amountCents: row.amountCents,
  }))

  // AN ENDED PLAN IS MEASURED AT THE MOMENT IT ENDED, not today. Its window
  // would otherwise stay open and swallow every rent charge since, so a plan
  // genuinely paid in full would read as unpaid again a month later - the
  // R-187 defect with its sign reversed. A live plan takes no bound: now is
  // the question being asked of it.
  const endedAt = plan.completedAt ?? plan.brokenAt ?? plan.cancelledAt

  return {
    id: plan.id,
    leaseId: plan.leaseId,
    status: plan.status,
    arrearsCents: plan.arrearsCents,
    startedOn,
    note: plan.note,
    instalments,
    progress: planProgress({
      instalments,
      paidCents: paidTowardPlan(entries, startedOn, timezone, endedAt),
      asOf: endedAt ? businessDate(endedAt, timezone) : today,
    }),
    createdAt: plan.createdAt,
    createdByName: plan.createdBy.name,
    brokenAt: plan.brokenAt,
    brokenOn: plan.brokenOn ? utcToBusinessDate(plan.brokenOn) : null,
    completedAt: plan.completedAt,
    cancelledAt: plan.cancelledAt,
    cancelledByName: plan.cancelledBy?.name ?? null,
    cancelReason: plan.cancelReason,
    holdInForce: plan.hold != null && plan.hold.liftedAt === null,
  }
}

/**
 * Every plan this tenancy has ever had, newest first.
 *
 * Ended plans come back deliberately, the same call `holdsForLease` makes: "we
 * offered them a plan in March and they broke it in May" is exactly what the
 * next conversation about this tenancy is about, and a screen showing only
 * the live one cannot say it.
 */
export async function plansForLease(
  leaseId: string,
  timezone: string,
  asOf: Date = new Date(),
): Promise<PlanView[]> {
  const plans = await prisma.paymentPlan.findMany({
    where: { leaseId },
    select: PLAN_SELECT,
    orderBy: { createdAt: 'desc' },
  })
  if (plans.length === 0) return []

  const entries = await prisma.ledgerEntry.findMany({
    where: { leaseId },
    select: { type: true, amountCents: true, occurredAt: true },
  })

  const today = businessDate(asOf, timezone)
  return plans.map((plan) => toPlanView(plan, entries, timezone, today))
}

/**
 * The live plan on each of these tenancies, for a bulk screen.
 *
 * Takes a set of lease ids rather than one, the same shape `leasesHalted`
 * settled on: every caller is the rent roll or a nightly sweep, and a
 * per-lease call inside a loop over the portfolio is a query per tenancy for
 * ever. Returns the raw rows rather than views, because the caller already
 * holds the ledger and the timezone this needs and would otherwise pay to
 * read them twice.
 */
export async function activePlansByLease(
  leaseIds: readonly string[],
  db: Db = prisma,
): Promise<Map<string, PlanRecord>> {
  if (leaseIds.length === 0) return new Map()
  const plans = await db.paymentPlan.findMany({
    where: { leaseId: { in: [...leaseIds] }, status: 'ACTIVE' },
    select: PLAN_SELECT,
  })
  return new Map(plans.map((plan) => [plan.leaseId, plan]))
}
