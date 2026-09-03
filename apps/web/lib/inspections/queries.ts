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
      property: {
        // state/county feed the entry-notice hint (R-157) via rulesFor().
        select: {
          id: true,
          name: true,
          legalEntityId: true,
          timezone: true,
          state: true,
          county: true,
        },
      },
      unit: { select: { id: true, name: true } },
      lease: { select: { id: true, status: true } },
      template: { select: { id: true, name: true } },
      performedBy: { select: { name: true } },
      items: {
        orderBy: { order: 'asc' },
        include: {
          photos: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true, fileName: true, capturedAt: true, latitude: true, longitude: true },
          },
          // The side-by-side comparison (INSP-02): each move-out item's own
          // move-in counterpart, via the real FK - never re-derived by
          // matching room/item text, which a re-labeled room would break.
          moveInItem: {
            select: {
              condition: true,
              notes: true,
              photos: {
                where: { deletedAt: null },
                orderBy: { createdAt: 'asc' },
                select: { id: true, fileName: true, capturedAt: true, latitude: true, longitude: true },
              },
            },
          },
        },
      },
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
