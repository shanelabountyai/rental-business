import 'server-only'

import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for the compliance calendar (PROP-05, R-077).
//
// SCOPED THROUGH BOTH `propertyIds` AND THE ENTITIES BEHIND THEM -
// `ResolvedScope` has no `legalEntityIds` of its own, so the visible set is
// derived from `availableProperties`, the same list the property switcher
// itself is built from.

function entityIdsInScope(scope: ResolvedScope): string[] {
  return [...new Set(scope.availableProperties.map((p) => p.legalEntityId))]
}

const complianceItemInclude = {
  property: { select: { id: true, name: true } },
  legalEntity: { select: { id: true, name: true } },
  completions: {
    orderBy: { completedOn: 'desc' as const },
    take: 1,
    select: { completedOn: true },
  },
} as const

export async function listComplianceItems(scope: ResolvedScope) {
  const entityIds = entityIdsInScope(scope)
  if (scope.propertyIds.length === 0 && entityIds.length === 0) return []

  return prisma.complianceItem.findMany({
    where: {
      OR: [
        { propertyId: { in: scope.propertyIds } },
        { legalEntityId: { in: entityIds } },
      ],
    },
    orderBy: { dueOn: 'asc' },
    include: complianceItemInclude,
  })
}

export async function getComplianceItem(id: string, scope: ResolvedScope) {
  const entityIds = entityIdsInScope(scope)
  const item = await prisma.complianceItem.findUnique({
    where: { id },
    include: {
      property: { select: { id: true, name: true, legalEntityId: true } },
      legalEntity: { select: { id: true, name: true } },
      completions: {
        orderBy: { completedOn: 'desc' },
        include: {
          completedBy: { select: { name: true } },
          document: { select: { id: true, fileName: true } },
        },
      },
    },
  })
  if (!item) return null
  const inScope = item.propertyId
    ? scope.propertyIds.includes(item.propertyId)
    : item.legalEntityId != null && entityIds.includes(item.legalEntityId)
  return inScope ? item : null
}

/// Every property AND legal entity in scope, for the "add item" form's own
/// scope picker (a property-level item vs. an entity-level one).
export async function complianceScopeOptions(scope: ResolvedScope) {
  const entityIds = entityIdsInScope(scope)
  const entities =
    entityIds.length > 0
      ? await prisma.legalEntity.findMany({
          where: { id: { in: entityIds } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        })
      : []
  return { properties: scope.availableProperties, entities }
}
