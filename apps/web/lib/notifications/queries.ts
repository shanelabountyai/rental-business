import 'server-only'

import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationChannel,
  channelsFor,
  defaultEnabled,
  isLockedCategory,
  lockedReason,
} from '@rental/core/notifications'
import type { NotificationRecipientType } from '@rental/db'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for the notification log and the preferences screen (NOTIF-01's
// "logged centrally", NOTIF-02's per-category preferences).

export interface NotificationLogFilter {
  category?: string
  status?: string
}

/**
 * The send log, newest first, scoped to what the actor can see.
 *
 * Portfolio-level notifications (propertyId null) are deliberately EXCLUDED
 * for a scoped actor and included for nobody but a full-portfolio one: a
 * notification with no property has no property to check a scope against, and
 * showing it to everyone would leak portfolio-level operations to a manager
 * confined to one house. `scope.propertyIds` is the switcher's already-
 * intersected list (R-007), so this inherits that filtering rather than
 * redoing it.
 */
export async function listNotifications(
  scope: ResolvedScope,
  filter: NotificationLogFilter = {},
  limit = 100,
) {
  if (scope.propertyIds.length === 0) return []

  return prisma.notification.findMany({
    where: {
      propertyId: { in: scope.propertyIds },
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.status ? { delivery: { status: filter.status as never } } : {}),
    },
    include: {
      delivery: true,
      // `timezone` so the log stamps each row in the zone of the property
      // it belongs to rather than the server's, which on Vercel is UTC
      // (R-115).
      property: { select: { id: true, name: true, timezone: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

export interface PreferenceRow {
  category: NotificationCategory
  channel: NotificationChannel
  enabled: boolean
  /// True when the recipient may not change it (NOTIF-02), with the
  /// explanation that must be shown alongside.
  locked: boolean
  lockedExplanation?: string
}

/**
 * Every category/channel pair with its effective setting - stored override
 * where one exists, category default otherwise.
 *
 * Computed rather than read straight out of the table on purpose: the table
 * holds only deliberate overrides (see NotificationPreference's own comment),
 * so a screen that rendered its rows directly would show a person who has
 * never touched their settings an empty page rather than what they are
 * actually signed up for.
 */
export async function getPreferences(
  recipientType: NotificationRecipientType,
  recipientId: string,
): Promise<PreferenceRow[]> {
  const stored = await prisma.notificationPreference.findMany({
    where: { recipientType, recipientId },
  })

  const overrides = new Map(
    stored.map((row) => [`${row.category}:${row.channel}`, row.enabled]),
  )

  const rows: PreferenceRow[] = []
  for (const category of NOTIFICATION_CATEGORIES) {
    for (const channel of channelsFor(category)) {
      const locked = isLockedCategory(category)
      rows.push({
        category,
        channel,
        // A locked category reports as on whatever the table says. The engine
        // resolves it the same way (resolveChannels ignores an override on a
        // locked category), so the screen cannot claim something the send
        // path would contradict.
        enabled: locked
          ? true
          : (overrides.get(`${category}:${channel}`) ??
            defaultEnabled(category, channel)),
        locked,
        lockedExplanation: locked ? lockedReason(category) : undefined,
      })
    }
  }
  return rows
}
