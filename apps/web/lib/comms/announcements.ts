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

/**
 * One choosable segment, and how many tenancies it reaches (R-115).
 *
 * THE COUNT IS THE POINT. The composer texts and emails everybody matching a
 * segment, had no confirmation step, and never said how many that was - the
 * per-recipient results table only renders after the send. The default is
 * "All tenants", so the highest blast radius was the option a mis-click landed
 * on, and nothing on the screen distinguished it from the smallest.
 *
 * The number goes in the OPTION rather than in the submit button, which is
 * where the audit put it: in the option it is visible before the choice is
 * made rather than after, and it needs no client state to stay accurate.
 *
 * It is an upper bound, deliberately. A lease under a `suppress_marketing`
 * hold, or a tenant whose merge fields cannot be filled, is dropped at send
 * time and named in the results - counting those here would mean running the
 * whole recipient resolution twice.
 */
export interface SegmentChoice {
  /// `ALL`, or `TYPE:value` — what the form posts, parsed by `parseSegment`.
  value: string
  label: string
  count: number
}

export interface SegmentOptions {
  all: SegmentChoice
  properties: SegmentChoice[]
  metros: SegmentChoice[]
  tags: SegmentChoice[]
}

/**
 * Splits what the picker posts back into the type and value `segmentWhere`
 * wants. `null` for anything it does not recognise — the caller refuses
 * rather than falling through to a filter that matches everyone.
 *
 * Splits on the FIRST colon only: a metro or tag is free text and may contain
 * one.
 */
export function parseSegment(
  posted: string,
): { type: SegmentType; value: string } | null {
  const colon = posted.indexOf(':')
  const type = colon === -1 ? posted : posted.slice(0, colon)
  if (!isSegmentType(type)) return null
  return { type, value: colon === -1 ? '' : posted.slice(colon + 1) }
}

/** What the composer's segment picker offers, narrowed to the actor's scope. */
export async function segmentOptions(scope: PropertyScope): Promise<SegmentOptions> {
  const empty = { all: { value: 'ALL', label: 'All tenants', count: 0 }, properties: [], metros: [], tags: [] }
  const where = propertyWhere(scope)
  if (where === null) return empty

  const properties = await prisma.property.findMany({
    where: { ...where, active: true },
    select: { id: true, name: true, metro: true, tags: true },
    orderBy: { name: 'asc' },
  })
  if (properties.length === 0) return empty

  // One groupBy rather than a count per option: a portfolio of 50 properties
  // with metros and tags is otherwise 150 round trips to render a dropdown.
  const grouped = await prisma.lease.groupBy({
    by: ['propertyId'],
    where: {
      status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] },
      propertyId: { in: properties.map((p) => p.id) },
    },
    _count: { _all: true },
  })
  const perProperty = new Map(grouped.map((g) => [g.propertyId, g._count._all]))
  const countOf = (matching: typeof properties) =>
    matching.reduce((total, p) => total + (perProperty.get(p.id) ?? 0), 0)

  const metros = [
    ...new Set(properties.map((p) => p.metro).filter((m): m is string => !!m)),
  ].sort()
  const tags = [...new Set(properties.flatMap((p) => p.tags))].sort()

  return {
    all: { value: 'ALL', label: 'All tenants', count: countOf(properties) },
    properties: properties.map((p) => ({
      value: `PROPERTY:${p.id}`,
      label: p.name,
      count: perProperty.get(p.id) ?? 0,
    })),
    metros: metros.map((metro) => ({
      value: `METRO:${metro}`,
      label: metro,
      count: countOf(properties.filter((p) => p.metro === metro)),
    })),
    tags: tags.map((tag) => ({
      value: `TAG:${tag}`,
      label: tag,
      count: countOf(properties.filter((p) => p.tags.includes(tag))),
    })),
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
