import 'server-only'

import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Read queries for units. A Unit has no legalEntityId of its own - only
// propertyId - so it is always scoped through its property, the same way
// R-004 scoped Ticket in its own integration tests.

export async function listUnits(propertyId: string, scope: ResolvedScope) {
  if (!scope.propertyIds.includes(propertyId)) return []
  return prisma.unit.findMany({
    where: { propertyId },
    orderBy: { name: 'asc' },
  })
}

export async function getUnitDetail(
  propertyId: string,
  unitId: string,
  scope: ResolvedScope,
) {
  if (!scope.propertyIds.includes(propertyId)) return null
  const unit = await prisma.unit.findUnique({
    where: { id: unitId },
    include: { property: { select: { id: true, name: true, legalEntityId: true } } },
  })
  // Belt and suspenders: also confirm the unit actually belongs to the
  // property named in the URL, not just SOME property in scope - a unit id
  // from one property must not render under a different property's route.
  if (!unit || unit.propertyId !== propertyId) return null
  return unit
}
