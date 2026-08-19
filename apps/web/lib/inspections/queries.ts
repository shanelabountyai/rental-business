import 'server-only'

import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for Inspection (INSP-01, R-068) - property-scoped, unlike the
// checklist templates it is built from (template-queries.ts's own header).

export async function inspectionsForScope(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  return prisma.inspection.findMany({
    where: { propertyId: { in: scope.propertyIds } },
    orderBy: { createdAt: 'desc' },
    include: {
      property: { select: { name: true } },
      unit: { select: { name: true } },
      // Condition only, not notes - just enough to derive IN_PROGRESS vs
      // SCHEDULED/DRAFT for the list without loading the full walk.
      items: { select: { condition: true } },
    },
  })
}

export async function getInspection(id: string, scope: ResolvedScope) {
  const inspection = await prisma.inspection.findUnique({
    where: { id },
    include: {
      property: { select: { id: true, name: true, legalEntityId: true, timezone: true } },
      unit: { select: { id: true, name: true } },
      lease: { select: { id: true } },
      template: { select: { id: true, name: true } },
      performedBy: { select: { name: true } },
      items: { orderBy: { order: 'asc' } },
    },
  })
  if (!inspection || !scope.propertyIds.includes(inspection.propertyId)) return null
  return inspection
}

/// For the "new inspection" unit picker - every unit in scope, with which
/// property it belongs to (a portfolio's picker needs both, the same shape
/// leases/queries.ts's own `unitsForNewLease` gives an identical form).
export async function unitsForNewInspection(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  return prisma.unit.findMany({
    where: { propertyId: { in: scope.propertyIds } },
    select: {
      id: true,
      name: true,
      property: { select: { id: true, name: true } },
      leases: {
        where: { status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
        select: { id: true },
        take: 1,
      },
    },
    orderBy: [{ property: { name: 'asc' } }, { name: 'asc' }],
  })
}
