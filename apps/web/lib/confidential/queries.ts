import 'server-only'

import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for confidential safety cases (RISK-04, ROLE-05; R-091).
//
// EVERY EXPORT HERE IS BEHIND `confidential.read`, checked by its caller.
// Nothing in this file is imported by any other module, deliberately: the way
// a wall like this fails is that somebody adds a convenient "does this lease
// have a case?" helper and calls it from a page nobody re-checked.

const caseInclude = {
  lease: {
    select: {
      id: true,
      propertyId: true,
      unitId: true,
      property: { select: { id: true, name: true, legalEntityId: true, timezone: true } },
      unit: { select: { id: true, name: true } },
      leaseTenants: {
        orderBy: { isPrimary: 'desc' },
        include: { tenant: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  },
  openedBy: { select: { name: true } },
  documentationSeenBy: { select: { name: true } },
  restrictedTenant: { select: { id: true, firstName: true, lastName: true } },
  lockChangeWorkOrder: {
    select: { id: true, status: true, scope: true, vendorId: true, createdAt: true },
  },
} as const

export async function listConfidentialCases(scope: ResolvedScope) {
  return prisma.confidentialCase.findMany({
    where: { lease: { propertyId: { in: scope.propertyIds } } },
    include: caseInclude,
    // Open first, then oldest first inside that: a safety case that has been
    // sitting for three weeks is the one to look at, and the register is the
    // only place anybody would notice.
    orderBy: [{ status: 'asc' }, { openedAt: 'asc' }],
  })
}

/**
 * One case, or null.
 *
 * NULL BECOMES A 404, NEVER A 403 (ROLE-01). The rule matters more here than
 * anywhere else it applies: "forbidden" on a case id confirms that a case
 * with that id exists, which is the single fact this whole feature is built
 * to withhold.
 */
export async function getConfidentialCase(id: string, scope: ResolvedScope) {
  const found = await prisma.confidentialCase.findUnique({ where: { id }, include: caseInclude })
  if (!found || !scope.propertyIds.includes(found.lease.propertyId)) return null
  return found
}

/// Whether this lease has any case at all - for the lease page, which renders
/// the control that opens one. Called ONLY after `confidential.read`.
export async function confidentialCaseCount(leaseId: string): Promise<{
  open: number
  total: number
}> {
  const [open, total] = await Promise.all([
    prisma.confidentialCase.count({ where: { leaseId, status: 'OPEN' } }),
    prisma.confidentialCase.count({ where: { leaseId } }),
  ])
  return { open, total }
}
