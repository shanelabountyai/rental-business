import 'server-only'

import type { PropertyScope } from '@rental/core/rbac'
import { prisma } from '@rental/db'

// Persistent announcement history (COMM-04, R-054), left behind by R-053:
// "persistent announcement history beyond the immediate per-send result
// table is R-054's."
//
// NO NEW TABLE. `sendAnnouncement()` already writes a full audit row -
// segment, template, requested/sent counts, every skip and why - the moment
// it sends (announcement-actions.ts). That row is already the evidence;
// what was missing was a READ, the exact gap R-052 found in COMM-05's
// "immutable audit log". A second table here would be the same duplicated-
// evidence risk R-052's own header warns against.
//
// PORTFOLIO-WIDE ONLY. An announcement is sent to a SEGMENT (properties by
// metro, tag or "all"), not to one property, so the audit row carries no
// propertyId a property-scoped manager's own scope could be checked
// against. Rather than guess at intersecting `segmentValue` with a scope -
// which would have to understand every segment type's own semantics just to
// answer an authorization question - this is simply reserved for an actor
// whose scope is already portfolio-wide. A property-scoped manager still
// sees the immediate per-send result right after sending; they do not get
// historical replay.
export interface AnnouncementHistoryEntry {
  id: string
  occurredAt: Date
  templateName: string | null
  segmentType: string | null
  segmentValue: string | null
  requested: number | null
  sent: number | null
  skippedCount: number | null
  sentByStaffId: string | null
}

export async function announcementHistory(
  scope: PropertyScope,
  limit = 100,
): Promise<AnnouncementHistoryEntry[] | null> {
  if (!scope.everything) return null

  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'MessageTemplate', action: 'message.announcement_sent' },
    orderBy: { occurredAt: 'desc' },
    take: limit,
  })

  return rows.map((row) => {
    const after = (row.after ?? {}) as Record<string, unknown>
    const skipped = Array.isArray(after.skipped) ? after.skipped : []
    return {
      id: row.id,
      occurredAt: row.occurredAt,
      templateName: typeof after.templateName === 'string' ? after.templateName : null,
      segmentType: typeof after.segmentType === 'string' ? after.segmentType : null,
      segmentValue: typeof after.segmentValue === 'string' ? after.segmentValue : null,
      requested: typeof after.requested === 'number' ? after.requested : null,
      sent: typeof after.sent === 'number' ? after.sent : null,
      skippedCount: skipped.length,
      sentByStaffId: typeof after.sentByStaffId === 'string' ? after.sentByStaffId : null,
    }
  })
}
