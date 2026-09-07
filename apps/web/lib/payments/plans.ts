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
 * What the tenancy has paid since the plan started.
 *
 * ==========================================================================
 * A REVERSAL IS CLASSIFIED BY ITS SIGN, NOT BY WHAT IT POINTS AT.
 *
 * Payments and credits are negative in this ledger; charges are positive. So
 * a REVERSAL that is POSITIVE can only be undoing something negative - a
 * returned cheque, a failed ACH debit - and a negative one is undoing a
 * charge, which is not a payment at all. That makes "did the money actually
 * stay" answerable without joining each reversal to the row it reverses, and
 * it matters here more than almost anywhere: a bounced payment that still
 * counted toward a repayment plan would keep the chase switched off against
 * a tenancy that has paid nothing.
 *
 * ADJUSTMENT is excluded in both directions. An adjustment is somebody
 * correcting the projection, not the tenant paying - and a plan kept by an
 * adjustment is a plan kept by us.
 * ==========================================================================
 *
 * `startedOn` is a calendar day in the property's zone and `occurredAt` is a
 * real timestamp, so the comparison goes through `businessDate` - the R-042
 * rule, in the direction that is correct for a timestamp.
 */
export function paidTowardPlan(
  entries: readonly PlanLedgerRow[],
  startedOn: BusinessDate,
  timezone: string,
): number {
  let credited = 0
  for (const entry of entries) {
    if (businessDate(entry.occurredAt, timezone) < startedOn) continue
    const counts =
      entry.type === 'PAYMENT' ||
      entry.type === 'CREDIT' ||
      (entry.type === 'REVERSAL' && entry.amountCents > 0)
    if (counts) credited += entry.amountCents
  }
  // Negated: a payment reduces what is owed, and "paid" is a positive number
  // everywhere it is read.
  return -credited
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
  /// The stored `status` is what the nightly sweep last decided; this is what
  /// is true right now, and a screen that showed the stored one would be up
  /// to a day stale on the only question anybody opens it to ask.
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
      paidCents: paidTowardPlan(entries, startedOn, timezone),
      asOf: today,
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
