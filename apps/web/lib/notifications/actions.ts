'use server'

import {
  channelsFor,
  isLockedCategory,
  isNotificationCategory,
  type NotificationChannel,
} from '@rental/core/notifications'
import type { NotificationRecipientType } from '@rental/db'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { propertyResource, requirePermission, requireStaff } from '@/lib/auth/guard.ts'
import { propertyForTenant } from '@/lib/consent/actions.ts'
import { requireTenant } from '@/lib/portal/guard.ts'

// Writes for notification preferences (NOTIF-02). One table, one refusal
// (the locked-category check), three ways in depending on who is asking and
// on whose behalf - `writePreference` is that shared refusal and write;
// everything below it is just deriving WHICH recipient a request may write.

export interface FormState {
  error?: string
}

async function writePreference(
  recipientType: NotificationRecipientType,
  recipientId: string,
  formData: FormData,
): Promise<FormState> {
  const category = String(formData.get('category') ?? '')
  const channel = String(formData.get('channel') ?? '')
  const enabled = formData.get('enabled') === 'on'

  if (!isNotificationCategory(category)) {
    return { error: 'Unknown notification category.' }
  }
  if (!(channelsFor(category) as readonly string[]).includes(channel)) {
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
        recipientType,
        recipientId,
        category,
        channel: channel as NotificationChannel,
      },
    },
    create: {
      recipientType,
      recipientId,
      category,
      channel: channel as NotificationChannel,
      enabled,
    },
    update: { enabled },
  })

  return {}
}

/// A staff member's OWN preferences. Nothing here takes a recipient id from
/// the form - it comes from the session, so a crafted submission cannot
/// change somebody else's preferences.
export async function setNotificationPreference(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireStaff()
  const result = await writePreference('STAFF', actor.id, formData)
  revalidatePath('/account')
  return result
}

/// A tenant's OWN preferences, from the portal (R-018). Same derivation as
/// the staff version: the recipient is the signed-in session, never the form.
export async function setOwnNotificationPreference(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const tenant = await requireTenant()
  const result = await writePreference('TENANT', tenant.id, formData)
  revalidatePath('/portal/account')
  return result
}

/// The staff-side mirror for the counter: a tenant calls in and asks for a
/// preference changed, and staff make the same edit `setOwnNotificationPreference`
/// would have made, on the tenant's behalf. Bound to `tenantId` at the page
/// (the `changeLeaseStatus.bind(null, lease.id, to)` shape this file already
/// uses elsewhere), never read from the submitted form - the same reasoning
/// `propertyForTenant` exists for: authorization is derived from the id that
/// was bound server-side, not from anything a client could forge.
export async function setTenantNotificationPreference(
  tenantId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const found = await propertyForTenant(tenantId)
  if (!found) return { error: 'That tenant is not on a lease at any property you can see.' }
  await requirePermission('tenant.write', propertyResource(found.property))

  const result = await writePreference('TENANT', tenantId, formData)
  revalidatePath(`/leases/${found.leaseId}`)
  return result
}
