import 'server-only'

import { CONDITION_BASELINE_DOCUMENT_TYPE } from '@rental/core/leases'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for lease records (LEASE-06, R-033). Scoped by ResolvedScope - the
// switcher's selection already intersected with RBAC - same as every other
// staff read in this repo.

const leaseInclude = {
  property: { select: { id: true, name: true, legalEntityId: true, timezone: true } },
  unit: { select: { id: true, name: true } },
  leaseTenants: {
    orderBy: { isPrimary: 'desc' },
    include: {
      tenant: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
    },
  },
  guarantors: { orderBy: { createdAt: 'asc' } },
} as const

/// Every lease in scope, running ones first. A PM opening this section is
/// almost always looking for a live tenancy, and burying them under a year
/// of ended ones is the difference between a list and a filing cabinet.
export async function listLeases(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  const leases = await prisma.lease.findMany({
    where: { propertyId: { in: scope.propertyIds } },
    include: leaseInclude,
    orderBy: [{ startsOn: 'desc' }],
  })

  const rank: Record<string, number> = {
    ACTIVE: 0,
    MONTH_TO_MONTH: 0,
    PENDING_SIGNATURE: 1,
    DRAFT: 1,
    ENDED: 2,
    TERMINATED: 2,
  }
  // Sorted in memory rather than by SQL: the ordering is by MEANING
  // (running / not yet / over), which Postgres cannot express over an enum
  // without a CASE expression Prisma has no way to emit. A 10-50 unit
  // portfolio's whole lease history is a few hundred rows.
  return leases.sort(
    (a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3),
  )
}

export async function getLease(id: string, scope: ResolvedScope) {
  const lease = await prisma.lease.findUnique({
    where: { id },
    include: {
      ...leaseInclude,
      documents: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          fileName: true,
          contentType: true,
          capturedAt: true,
          createdAt: true,
        },
      },
    },
  })
  if (!lease || !scope.propertyIds.includes(lease.propertyId)) return null
  return lease
}

/// Whether a condition-as-found baseline exists (RISK-08). Its own query
/// rather than a filter over the documents already loaded, because the gap
/// check runs on the list page too, where documents are not fetched.
export async function hasConditionBaseline(leaseId: string): Promise<boolean> {
  const count = await prisma.document.count({
    where: {
      leaseId,
      type: CONDITION_BASELINE_DOCUMENT_TYPE,
      deletedAt: null,
    },
  })
  return count > 0
}

/**
 * Units in scope that could take a new lease, with whatever tenancy is
 * already running on them.
 *
 * Does NOT filter occupied units out. A unit whose lease ends next month
 * legitimately needs next month's lease created now, and hiding it would
 * make the ordinary renewal impossible. What the form does instead is show
 * the running tenancy inline, so somebody about to double-book a unit sees
 * it before they save rather than after.
 */
export async function unitsForNewLease(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  const units = await prisma.unit.findMany({
    where: { propertyId: { in: scope.propertyIds } },
    select: {
      id: true,
      name: true,
      status: true,
      marketRentCents: true,
      property: { select: { id: true, name: true } },
      leases: {
        where: { status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
        select: { id: true, endsOn: true, isMonthToMonth: true },
        take: 1,
      },
    },
    orderBy: [{ property: { name: 'asc' } }, { name: 'asc' }],
  })
  return units
}

/// Tenants who could be added to a lease. A 10-50 unit portfolio's tenant
/// list is short enough to offer whole; a search box over a few hundred
/// names is UI nobody needs yet.
export async function selectableTenants() {
  return prisma.tenant.findMany({
    where: { active: true },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  })
}
