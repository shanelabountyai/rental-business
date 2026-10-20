import { type BusinessDate, businessDaysBetween } from '../scheduling/local-time.ts'

// Announcement segments (COMM-04, R-053; R-258). Pure: what the picker posts,
// and whether one tenancy's facts match it. apps/web/lib/comms/announcements.ts
// loads the facts and uses `matchesSegment` for BOTH the picker's counts and
// the send, so the two cannot disagree.

export const SEGMENT_TYPES = [
  'ALL',
  'ENTITY',
  'PROPERTY',
  'UNIT',
  'METRO',
  'TAG',
  'STATUS',
  'BALANCE_DUE',
  'MOVE_IN',
  'MOVE_OUT',
  'OPEN_MAINTENANCE',
] as const
export type SegmentType = (typeof SEGMENT_TYPES)[number]

export function isSegmentType(value: string): value is SegmentType {
  return (SEGMENT_TYPES as readonly string[]).includes(value)
}

/// The tenancies an announcement can reach at all. A segment narrows this,
/// never widens it.
export const SENDABLE_STATUSES = ['ACTIVE', 'MONTH_TO_MONTH'] as const

/// The move-in/out windows the picker offers. A fixed list rather than a
/// number field: a second control only exists once the page has hydrated,
/// which is exactly the bug R-115 removed (see `sendAnnouncement`).
export const WINDOW_DAYS = [7, 30, 60] as const

export interface Segment {
  type: SegmentType
  value: string
}

/**
 * Splits what the picker posts back into a type and value. `null` for
 * anything it does not recognise, or a type missing the value it needs — the
 * caller refuses rather than falling through to a filter that matches
 * everyone.
 *
 * Splits on the FIRST colon only: a metro or tag is free text and may contain
 * one.
 */
export function parseSegment(posted: string): Segment | null {
  const colon = posted.indexOf(':')
  const type = colon === -1 ? posted : posted.slice(0, colon)
  const value = colon === -1 ? '' : posted.slice(colon + 1)
  if (!isSegmentType(type)) return null
  switch (type) {
    case 'ALL':
    case 'BALANCE_DUE':
    case 'OPEN_MAINTENANCE':
      return { type, value: '' }
    case 'STATUS':
      return (SENDABLE_STATUSES as readonly string[]).includes(value) ? { type, value } : null
    case 'MOVE_IN':
    case 'MOVE_OUT':
      return (WINDOW_DAYS as readonly number[]).map(String).includes(value) ? { type, value } : null
    default:
      return value ? { type, value } : null
  }
}

/// What `matchesSegment` needs to know about one tenancy. Dates are business
/// dates in the PROPERTY's zone, so "within 7 days" means the property's
/// calendar, not the server's.
export interface TenancyFacts {
  leaseId: string
  legalEntityId: string
  propertyId: string
  unitId: string
  metro: string | null
  tags: string[]
  status: string
  today: BusinessDate
  startsOn: BusinessDate
  /// The day the tenancy actually ends: notice's effective date if notice
  /// was given (R-066), else the fixed term's end. `null` for an MTM with
  /// no notice.
  endsOn: BusinessDate | null
  balanceCents: number
  openMaintenance: boolean
}

export function matchesSegment(facts: TenancyFacts, segment: Segment): boolean {
  switch (segment.type) {
    case 'ALL':
      return true
    case 'ENTITY':
      return facts.legalEntityId === segment.value
    case 'PROPERTY':
      return facts.propertyId === segment.value
    case 'UNIT':
      return facts.unitId === segment.value
    case 'METRO':
      return facts.metro === segment.value
    case 'TAG':
      return facts.tags.includes(segment.value)
    case 'STATUS':
      return facts.status === segment.value
    case 'BALANCE_DUE':
      return facts.balanceCents > 0
    case 'MOVE_IN': {
      // Either side of today: "welcome, here is how trash day works" goes to
      // somebody who moved in last week as much as somebody moving in next.
      const days = businessDaysBetween(facts.today, facts.startsOn)
      return Math.abs(days) <= Number(segment.value)
    }
    case 'MOVE_OUT': {
      // Forward only: a tenancy whose end date has passed and is still
      // ACTIVE is a stale record, not somebody moving out.
      if (facts.endsOn === null) return false
      const days = businessDaysBetween(facts.today, facts.endsOn)
      return days >= 0 && days <= Number(segment.value)
    }
    case 'OPEN_MAINTENANCE':
      return facts.openMaintenance
  }
}

