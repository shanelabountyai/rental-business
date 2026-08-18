import 'server-only'

import { type Prospect, prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for Prospect (LEASE-07, R-058).

export async function prospectsForScope(scope: ResolvedScope): Promise<Prospect[]> {
  if (scope.propertyIds.length === 0) return []
  return prisma.prospect.findMany({
    where: { propertyId: { in: scope.propertyIds } },
    orderBy: { createdAt: 'desc' },
  })
}

export async function prospectForWrite(
  prospectId: string,
  scope: ResolvedScope,
): Promise<Prospect | null> {
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!prospect || !scope.propertyIds.includes(prospect.propertyId)) return null
  return prospect
}
