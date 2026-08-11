import 'server-only'

import { prisma } from '@rental/db'

// PAY-04's waiver-pattern report (R-040).
//
// SEPARATE FROM waivers.ts BECAUSE THAT FILE IS `'use server'`. Exporting a
// query from a server-action module publishes it as a client-callable
// endpoint - anybody could call it with any property ids. It is a READ with
// scoping consequences, so it lives behind `server-only` and takes its scope
// from a caller that has already checked permissions.

export interface WaiverPatternRow {
  tenantId: string
  tenantName: string
  leaseId: string
  feesAssessed: number
  feesWaived: number
  assessedCents: number
  waivedCents: number
  /// Waived as a share of assessed, 0-1. The number the report is actually
  /// about - a tenant at 1.0 beside a tenant at 0.0 is the pattern.
  waivedShare: number
}

/**
 * Who has had fees forgiven, and who has not (PAY-04).
 *
 * DELIBERATELY REPORTS EVERY TENANT WITH AN ASSESSED FEE, including those
 * with no waivers at all. A report of waivers alone shows only generosity and
 * hides its distribution, which is the opposite of what a fair-housing review
 * needs - the tenants who were never forgiven anything are half the pattern.
 *
 * Ordered by share waived, descending, so the extremes sit at the ends where
 * they can be compared rather than in the middle of an alphabetical list.
 *
 * This reports a PATTERN, never a verdict. An uneven distribution has plenty
 * of lawful explanations; what it must not be is invisible.
 */
export async function waiverPatternByTenant(
  propertyIds: readonly string[],
): Promise<WaiverPatternRow[]> {
  if (propertyIds.length === 0) return []

  const fees = await prisma.charge.findMany({
    where: {
      propertyId: { in: [...propertyIds] },
      type: { in: ['LATE_FEE', 'NSF_FEE'] },
    },
    select: {
      leaseId: true,
      amountCents: true,
      waivedAt: true,
      lease: {
        select: {
          leaseTenants: {
            select: { tenant: { select: { id: true, firstName: true, lastName: true } } },
          },
        },
      },
    },
  })

  const byTenant = new Map<string, WaiverPatternRow>()
  for (const fee of fees) {
    // Attributed to the FIRST tenant on the lease. A joint tenancy shares one
    // ledger, so a per-tenant split would be inventing an attribution the
    // money does not have - and for the purpose of this report, what matters
    // is that the household appears once.
    const tenant = fee.lease.leaseTenants[0]?.tenant
    if (!tenant) continue

    const row = byTenant.get(tenant.id) ?? {
      tenantId: tenant.id,
      tenantName: `${tenant.firstName} ${tenant.lastName}`,
      leaseId: fee.leaseId,
      feesAssessed: 0,
      feesWaived: 0,
      assessedCents: 0,
      waivedCents: 0,
      waivedShare: 0,
    }
    row.feesAssessed += 1
    row.assessedCents += fee.amountCents
    if (fee.waivedAt) {
      row.feesWaived += 1
      row.waivedCents += fee.amountCents
    }
    byTenant.set(tenant.id, row)
  }

  return [...byTenant.values()]
    .map((row) => ({
      ...row,
      waivedShare: row.assessedCents === 0 ? 0 : row.waivedCents / row.assessedCents,
    }))
    .sort((a, b) => b.waivedShare - a.waivedShare || b.assessedCents - a.assessedCents)
}
