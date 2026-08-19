import 'server-only'

import { CONDITION_BASELINE_DOCUMENT_TYPE } from '@rental/core/leases'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for lease records (LEASE-06, R-033). Scoped by ResolvedScope - the
// switcher's selection already intersected with RBAC - same as every other
// staff read in this repo.

const leaseInclude = {
  property: { select: { id: true, name: true, legalEntityId: true, timezone: true, state: true, county: true } },
  unit: { select: { id: true, name: true, marketRentCents: true } },
  leaseTenants: {
    orderBy: { isPrimary: 'desc' },
    include: {
      tenant: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
    },
  },
  guarantors: { orderBy: { createdAt: 'asc' } },
  // LEASE-09 (R-065): the renewal lineage in both directions. Small enough
  // to carry on every read rather than a second query - a lease has at most
  // a handful of renewal attempts over its life (LeaseEnvelope.leaseId's
  // own "not unique" precedent, applied here).
  renewedFrom: { select: { id: true, status: true, endsOn: true, rentCents: true } },
  renewalLeases: {
    select: { id: true, status: true, startsOn: true, rentCents: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  },
  // LEASE-10 (R-067): most-recent-first, so `[0]` is always "the current
  // policy" - RenterInsurancePolicy.leaseId is deliberately not unique (see
  // the model's own comment), history and all.
  renterInsurancePolicies: {
    orderBy: { createdAt: 'desc' },
    include: { document: { select: { id: true, fileName: true } } },
  },
  // R-066 (LEASE-11): the non-renewal notice, if the landlord ever served
  // one - just enough to link to it. A tenant's own notice to vacate is
  // never a Notice row (recordLeaseNotice's own comment), so this can only
  // ever hold NON_RENEWAL rows in practice.
  notices: {
    orderBy: { createdAt: 'desc' },
    select: { id: true, type: true, servedAt: true },
  },
  // R-069: whether the deposit has actually cleared is read as "does a
  // Deposit row exist yet" (deposit-clearing-job.ts's own job creates it),
  // not recomputed here - one source of truth, derived once.
  deposits: { select: { id: true, receivedAt: true } },
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
      // R-063: at most one non-VOIDED at a time (LeaseEnvelope.leaseId's own
      // comment) - most recent first so the page's own "current envelope"
      // read is just `envelopes[0]`, with any earlier voided ones still
      // visible as the record of what was withdrawn and why.
      envelopes: {
        orderBy: { createdAt: 'desc' },
        include: { signers: { orderBy: { order: 'asc' } } },
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
