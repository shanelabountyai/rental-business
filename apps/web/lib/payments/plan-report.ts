import 'server-only'

import type { PaymentPlanStatus } from '@rental/core/payments'
import { prisma } from '@rental/db'

// PAY-04's fair-housing question, asked about plans instead of waivers
// (R-175).
//
// SEPARATE FROM plan-actions.ts BECAUSE THAT FILE IS `'use server'` - the
// same split waiver-report.ts makes, and for the same reason: exporting a
// query from a server-action module publishes it as a client-callable
// endpoint. It is a READ with scoping consequences, so it lives behind
// `server-only` and takes its scope from a caller that has already checked
// permissions.

export interface PlanOfferRow {
  tenantId: string
  tenantName: string
  leaseId: string
  /// Late and returned-payment fees ever assessed. Half of what makes this
  /// tenancy a candidate for a plan in the first place.
  feesAssessed: number
  /// Notices ever served on the tenancy. The other half - and the column the
  /// review's own sentence is about: "who was offered a plan and who went
  /// straight to a notice".
  noticesServed: number
  plansAgreed: number
  /// The most recent plan's status, or null where none was ever agreed.
  latestPlanStatus: PaymentPlanStatus | null
  offered: boolean
}

/**
 * Who was offered a repayment plan, and who was not (PAY-04's shape, PAY-08's
 * subject).
 *
 * ==========================================================================
 * DELIBERATELY REPORTS EVERY TENANCY THAT REACHED A COLLECTIONS STEP,
 * including - especially - the ones that were never offered anything.
 *
 * The waiver report already makes this argument and it is the same one here:
 * a report of plans alone shows only leniency and hides its distribution,
 * which is the opposite of what a fair-housing review needs. A repayment plan
 * is the decision that avoids a filing fee, an attorney and a month of
 * vacancy, and deciding it case by case, in one person's head, along lines
 * that happen to correlate with a protected class, is a disparate-treatment
 * pattern whatever the intent behind it.
 *
 * The denominator is "a fee was assessed or a notice was served" - the two
 * recorded facts that mean somebody had already decided this tenancy was in
 * arrears. It is not "everyone with a balance": a tenant three days late on
 * the 4th is not somebody anybody chose not to offer a plan to.
 *
 * Ordered with the never-offered, most-noticed tenancies FIRST. The extremes
 * belong at the ends where they can be compared, not scattered through an
 * alphabet - and this end is the one an operator is least likely to go
 * looking for.
 * ==========================================================================
 *
 * THIS REPORTS A PATTERN AND NEVER A VERDICT. An uneven distribution has
 * plenty of lawful explanations; a tenant who was never asked, or who broke
 * two plans already, is not the same case as one who was never offered.
 * What it must not be is invisible.
 */
export async function planOfferPatternByTenant(
  propertyIds: readonly string[],
): Promise<PlanOfferRow[]> {
  if (propertyIds.length === 0) return []

  const [fees, notices, plans] = await Promise.all([
    prisma.charge.groupBy({
      by: ['leaseId'],
      where: { propertyId: { in: [...propertyIds] }, type: { in: ['LATE_FEE', 'NSF_FEE'] } },
      _count: { _all: true },
    }),
    // SERVED notices only. A drafted notice nobody delivered is not a
    // decision to skip the conversation - it may be the draft somebody
    // abandoned in favour of agreeing a plan.
    prisma.notice.groupBy({
      by: ['leaseId'],
      where: { propertyId: { in: [...propertyIds] }, leaseId: { not: null }, servedAt: { not: null } },
      _count: { _all: true },
    }),
    prisma.paymentPlan.findMany({
      where: { propertyId: { in: [...propertyIds] } },
      select: { leaseId: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  const leaseIds = new Set<string>([
    ...fees.map((row) => row.leaseId),
    ...notices.flatMap((row) => (row.leaseId ? [row.leaseId] : [])),
    ...plans.map((row) => row.leaseId),
  ])
  if (leaseIds.size === 0) return []

  const leases = await prisma.lease.findMany({
    where: { id: { in: [...leaseIds] } },
    select: {
      id: true,
      leaseTenants: {
        select: { tenant: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  })

  const feeCount = new Map(fees.map((row) => [row.leaseId, row._count._all]))
  const noticeCount = new Map(
    notices.flatMap((row) => (row.leaseId ? [[row.leaseId, row._count._all] as const] : [])),
  )

  const planCount = new Map<string, number>()
  const latestStatus = new Map<string, PaymentPlanStatus>()
  for (const plan of plans) {
    planCount.set(plan.leaseId, (planCount.get(plan.leaseId) ?? 0) + 1)
    // Ordered newest-first, so the FIRST one seen per lease is the latest.
    if (!latestStatus.has(plan.leaseId)) latestStatus.set(plan.leaseId, plan.status)
  }

  const rows: PlanOfferRow[] = []
  for (const lease of leases) {
    // Attributed to the FIRST tenant on the lease, the same call the waiver
    // report makes: a joint tenancy shares one ledger, so a per-tenant split
    // would invent an attribution the money does not have, and what matters
    // here is that the household appears exactly once.
    const tenant = lease.leaseTenants[0]?.tenant
    if (!tenant) continue

    const plansAgreed = planCount.get(lease.id) ?? 0
    rows.push({
      tenantId: tenant.id,
      tenantName: `${tenant.firstName} ${tenant.lastName}`,
      leaseId: lease.id,
      feesAssessed: feeCount.get(lease.id) ?? 0,
      noticesServed: noticeCount.get(lease.id) ?? 0,
      plansAgreed,
      latestPlanStatus: latestStatus.get(lease.id) ?? null,
      offered: plansAgreed > 0,
    })
  }

  return rows.sort(
    (a, b) =>
      Number(a.offered) - Number(b.offered) ||
      b.noticesServed - a.noticesServed ||
      b.feesAssessed - a.feesAssessed ||
      a.tenantName.localeCompare(b.tenantName),
  )
}
