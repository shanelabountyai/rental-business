import 'server-only'

import { type PropertyScope } from '@rental/core/rbac'
import { type Prisma, prisma } from '@rental/db'
import { propertyWhere } from '@/lib/auth/guard.ts'

// Segment resolution for staff-authored announcements (COMM-04, R-053).
//
// Deliberately different from R-044's bulk chase (apps/web/lib/payments/
// reminders.ts), which sends to an EXPLICIT list of lease ids reviewed on
// screen because re-evaluating "who's chaseable" at send time could chase
// someone who paid in the meantime. An announcement has no such fact to go
// stale — "the city is flushing hydrants Tuesday" is true for whoever is a
// tenant at send time, and the whole point of a segment is that nobody
// enumerates it by hand. Resolving it as a filter, at send time, against the
// same `propertyWhere()` every other scoped list in this app already uses,
// is correct here rather than the shortcut that rule exists to forbid.

export const SEGMENT_TYPES = ['ALL', 'PROPERTY', 'METRO', 'TAG'] as const
export type SegmentType = (typeof SEGMENT_TYPES)[number]

export function isSegmentType(value: string): value is SegmentType {
  return (SEGMENT_TYPES as readonly string[]).includes(value)
}

export interface SegmentOptions {
  properties: { id: string; name: string }[]
  metros: string[]
  tags: string[]
}

/** What the composer's segment picker offers, narrowed to the actor's scope. */
export async function segmentOptions(scope: PropertyScope): Promise<SegmentOptions> {
  const where = propertyWhere(scope)
  if (where === null) return { properties: [], metros: [], tags: [] }

  const properties = await prisma.property.findMany({
    where: { ...where, active: true },
    select: { id: true, name: true, metro: true, tags: true },
    orderBy: { name: 'asc' },
  })

  return {
    properties: properties.map((p) => ({ id: p.id, name: p.name })),
    metros: [
      ...new Set(properties.map((p) => p.metro).filter((m): m is string => !!m)),
    ].sort(),
    tags: [...new Set(properties.flatMap((p) => p.tags))].sort(),
  }
}

/**
 * The `Property` filter for one resolved segment. `null` means the segment
 * type needs a value that wasn't given — the caller refuses rather than
 * falling through to "no filter", which would silently broadcast to
 * everyone.
 */
export function segmentWhere(
  segmentType: SegmentType,
  segmentValue: string,
): Prisma.PropertyWhereInput | null {
  switch (segmentType) {
    case 'ALL':
      return {}
    case 'PROPERTY':
      return segmentValue ? { id: segmentValue } : null
    case 'METRO':
      return segmentValue ? { metro: segmentValue } : null
    case 'TAG':
      return segmentValue ? { tags: { has: segmentValue } } : null
  }
}
