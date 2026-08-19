import 'server-only'

import type { TenantScope } from '@rental/core/portal'
import { prisma } from '@rental/db'

// Reads for a tenant's own inspection review (INSP-01, R-068 phase 2) -
// scoped by lease, the same DOC-03-shaped rule every other portal read
// enforces server-side.

/// Inspections on this tenant's own lease(s) waiting on their signature -
/// performed, not yet signed, not yet locked. What a "review and sign"
/// prompt on the portal reads to decide whether to show one at all.
export async function inspectionsAwaitingTenantSignature(scope: TenantScope) {
  if (scope.leaseIds.length === 0) return []
  return prisma.inspection.findMany({
    where: {
      leaseId: { in: [...scope.leaseIds] },
      performedAt: { not: null },
      tenantSignedAt: null,
      lockedAt: null,
    },
    orderBy: { performedAt: 'asc' },
    include: {
      property: { select: { name: true, addressLine1: true } },
      unit: { select: { name: true } },
    },
  })
}

/// One inspection, with its items - null if it is not on this tenant's own
/// lease. "Not yours" and "does not exist" read the same, the same rule
/// DOC-03 already states for every other portal read.
export async function getTenantInspection(id: string, scope: TenantScope) {
  if (scope.leaseIds.length === 0) return null
  const inspection = await prisma.inspection.findUnique({
    where: { id },
    include: {
      property: { select: { name: true, addressLine1: true, timezone: true } },
      unit: { select: { name: true } },
      items: {
        orderBy: { order: 'asc' },
        include: {
          photos: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          },
        },
      },
    },
  })
  if (!inspection || !inspection.leaseId || !scope.leaseIds.includes(inspection.leaseId)) {
    return null
  }
  return inspection
}
