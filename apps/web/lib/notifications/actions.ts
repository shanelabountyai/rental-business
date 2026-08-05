'use server'

import {
  isLockedCategory,
  isNotificationCategory,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from '@rental/core/notifications'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { requireStaff } from '@/lib/auth/guard.ts'

// Writes for a staff member's own notification preferences (NOTIF-02).
//
// No permission check beyond "is signed-in staff": these are the actor's OWN
// settings, and `requireStaff()` already establishes who that is. Nothing
// here takes a recipient id from the form - it comes from the session, so a
// crafted submission cannot change somebody else's preferences.
//
// Tenant preferences are the same table and the same refusal below, reached
// through the tenant portal (R-018) once it exists.

export interface FormState {
  error?: string
}

export async function setNotificationPreference(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireStaff()

  const category = String(formData.get('category') ?? '')
  const channel = String(formData.get('channel') ?? '')
  const enabled = formData.get('enabled') === 'on'

  if (!isNotificationCategory(category)) {
    return { error: 'Unknown notification category.' }
  }
  if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
    return { error: 'Unknown channel.' }
  }
  // The server-side half of NOTIF-02's lock. The screen does not render a
  // control for these, which is a courtesy; this is the rule. `resolveChannels`
  // would ignore such a row anyway - refusing to write it as well keeps the
  // table from holding a preference the engine will never honour, which is
  // exactly the sort of stored lie that makes a later reader distrust the
  // whole table.
  if (isLockedCategory(category)) {
    return {
      error: 'That category is required and cannot be turned off.',
    }
  }

  await prisma.notificationPreference.upsert({
    where: {
      recipientType_recipientId_category_channel: {
        recipientType: 'STAFF',
        recipientId: actor.id,
        category,
        channel: channel as NotificationChannel,
      },
    },
    create: {
      recipientType: 'STAFF',
      recipientId: actor.id,
      category,
      channel: channel as NotificationChannel,
      enabled,
    },
    update: { enabled },
  })

  revalidatePath('/account')
  return {}
}
