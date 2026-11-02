'use server'

import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requireStaff } from '@/lib/auth/guard.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { issueToken, revokeTokens } from '@/lib/auth/store.ts'

// Issuing and re-issuing a staff calendar subscription (NOTIF-06, R-097c).
//
// NO PERMISSION CHECK BEYOND BEING SIGNED-IN STAFF, and that is correct
// rather than an omission: this hands somebody a feed of exactly what they
// can already see, resolved fresh on every fetch from their own scope. There
// is no version of it that shows them more than the app does, so gating it
// behind a permission would be gating a view of one's own work.
//
// RE-ISSUING REVOKES ONLY THEIR OWN. A single shared feed URL would mean a
// leak fixable only by rotating everybody, which in practice means it never
// gets rotated at all.

export interface CalendarFeedState {
  error?: string
  notice?: string
  url?: string
}

export async function regenerateCalendarFeed(): Promise<CalendarFeedState> {
  const actor = await requireStaff()
  // A staff member's own feed, keyed by their StaffUser row. A support
  // session passes requireStaff (R-295b) but is no staff account, and minting
  // a feed would be a write it may not make (PLAT-06).
  if (actor.kind !== 'staff') return { error: 'Only a staff account has a calendar feed.' }

  const revoked = await revokeTokens('CALENDAR_FEED', actor.id)
  const issued = await issueToken('CALENDAR_FEED', { type: 'StaffUser', id: actor.id })

  await audit({
    action: 'staff.calendar_feed_issued',
    entityType: 'StaffUser',
    entityId: actor.id,
    after: {
      // How many old links this killed - the number somebody wants when they
      // are asking "did the leaked one stop working". Never the token.
      revokedCount: revoked,
    },
  })

  revalidatePath('/account')
  return {
    url: await authUrl(actor.orgId, `/api/calendar/${issued.token}`),
    notice:
      revoked > 0
        ? 'A new link. Any calendar still subscribed to the old one will stop updating — resubscribe with this.'
        : 'Subscribe your calendar to this link.',
  }
}
