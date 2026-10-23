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
  /// R-261: what the row records - a send, a schedule, or a cancellation.
  /// R-262: or a resend of an earlier row's failures.
  kind: 'sent' | 'scheduled' | 'cancelled' | 'resent'
  /// Property-local wall clock for a scheduled or cancelled row.
  sendAt: string | null
  /// R-262: the deliveries this row created. Empty on a row written before
  /// R-262 and on a cancellation, which creates none.
  deliveryIds: string[]
}

/// R-262: one recipient-channel of one announcement, as it stands NOW on
/// NotificationDelivery - a Twilio callback that lands a week later moves it.
export interface AnnouncementDelivery {
  id: string
  tenantName: string
  channel: string
  status: string
  reason: string | null
}

/// Every delivery the given history rows created, keyed by row id. One query
/// for the whole page rather than one per row.
export async function announcementDeliveries(
  entries: readonly AnnouncementHistoryEntry[],
): Promise<Map<string, AnnouncementDelivery[]>> {
  const ids = entries.flatMap((e) => e.deliveryIds)
  if (ids.length === 0) return new Map()
  const rows = await prisma.notificationDelivery.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      suppressedReason: true,
      failureCode: true,
      notification: { select: { channel: true, recipientId: true } },
    },
  })
  const tenants = new Map(
    (
      await prisma.tenant.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.notification.recipientId))] } },
        select: { id: true, firstName: true, lastName: true },
      })
    ).map((t) => [t.id, `${t.firstName} ${t.lastName}`]),
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  const result = new Map<string, AnnouncementDelivery[]>()
  for (const entry of entries) {
    const list: AnnouncementDelivery[] = []
    for (const id of entry.deliveryIds) {
      const row = byId.get(id)
      if (!row) continue
      list.push({
        id,
        tenantName: tenants.get(row.notification.recipientId) ?? '—',
        channel: row.notification.channel,
        status: row.status,
        reason: row.suppressedReason ?? row.failureCode ?? null,
      })
    }
    list.sort((x, y) => x.tenantName.localeCompare(y.tenantName) || x.channel.localeCompare(y.channel))
    result.set(entry.id, list)
  }
  return result
}

/// The statuses "resend to failed" acts on: a provider refused it, for good.
/// Not SUPPRESSED (a decision) and not DEFERRED (R-106 is still retrying).
export const RESENDABLE_STATUSES: readonly string[] = ['FAILED', 'BOUNCED']

export async function announcementHistory(
  scope: PropertyScope,
  limit = 100,
): Promise<AnnouncementHistoryEntry[] | null> {
  if (!scope.everything) return null

  const rows = await prisma.auditLog.findMany({
    where: {
      // R-285b: `everything` is the actor's org, never the database.
      orgId: scope.orgId,
      entityType: 'MessageTemplate',
      action: {
        in: [
          'message.announcement_sent',
          'message.announcement_scheduled',
          'message.announcement_cancelled',
          'message.announcement_resent',
        ],
      },
    },
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
      kind:
        row.action === 'message.announcement_scheduled'
          ? 'scheduled'
          : row.action === 'message.announcement_cancelled'
            ? 'cancelled'
            : row.action === 'message.announcement_resent'
              ? 'resent'
              : 'sent',
      sendAt: typeof after.sendAt === 'string' ? after.sendAt : null,
      deliveryIds: Array.isArray(after.deliveryIds) ? after.deliveryIds.map(String) : [],
    }
  })
}
