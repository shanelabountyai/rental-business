'use server'

import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import type { FormState } from '@/components/auth-form.tsx'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission, requireScope } from '@/lib/auth/guard.ts'

// The messaging settings page's two forms (R-266, PRD 08 B5).
//
// `template.write` is the permission, as for the templates themselves: this
// is the same comms configuration. The business name and the reply assignee
// are portfolio-wide, so the check carries no resource and a property-scoped
// manager is refused; quiet hours belong to one property and are checked
// against it.

const BUSINESS_NAME_MAX = 60

export async function saveMessagingSettings(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('template.write')

  const businessName = String(formData.get('businessName') ?? '').trim()
  if (businessName.length > BUSINESS_NAME_MAX) {
    return { error: `Keep the business name to ${BUSINESS_NAME_MAX} characters; it is in every text.` }
  }
  if (/[\r\n]/.test(businessName)) return { error: 'The business name must be one line.' }

  const posted = String(formData.get('replyTaskAssigneeStaffId') ?? '')
  const replyTaskAssigneeStaffId = posted === '' || posted === 'anyone' ? null : posted
  if (replyTaskAssigneeStaffId) {
    // Somebody who can work tasks somewhere. Whether they cover the property
    // a reply comes in for is asked per reply (`replyTaskAssignee`).
    const grant = await prisma.staffAssignment.findFirst({
      where: {
        orgId: actor.orgId,
        staffUserId: replyTaskAssigneeStaffId,
        revokedAt: null,
        staffUser: { active: true },
        role: { permissions: { has: 'task.write' } },
      },
      select: { id: true },
    })
    if (!grant) return { error: 'That person cannot work tasks. Pick someone else.' }
  }

  // R-285b: one row per org - keyed by the org, not the old 'default' id.
  // A new org's row takes its org id as its id (the column defaults to
  // 'default', which org #0's row already holds).
  const before = await prisma.messagingSettings.findUnique({
    where: { orgId: actor.orgId },
    select: { businessName: true, replyTaskAssigneeStaffId: true },
  })
  const after = { businessName: businessName || null, replyTaskAssigneeStaffId }
  await prisma.$transaction(async (tx) => {
    const saved = await tx.messagingSettings.upsert({
      where: { orgId: actor.orgId },
      create: { id: actor.orgId, orgId: actor.orgId, ...after },
      update: after,
    })
    await audit(
      {
        action: 'messaging_settings.updated',
        entityType: 'MessagingSettings',
        entityId: saved.id,
        before: before ?? undefined,
        after,
      },
      tx,
    )
  })

  revalidatePath('/messages/settings')
  return { notice: 'Messaging settings saved.' }
}

/// `default` for both, or two different whole hours.
function parseHour(value: FormDataEntryValue | null): number | 'default' | null {
  const text = String(value ?? '')
  if (text === 'default') return 'default'
  if (!/^\d{1,2}$/.test(text)) return null
  const hour = Number(text)
  return hour <= 23 ? hour : null
}

export async function saveQuietHours(_previous: FormState, formData: FormData): Promise<FormState> {
  const propertyId = String(formData.get('propertyId') ?? '')
  const { actor: guarded } = await requireScope('template.write')
  const property = await prisma.property.findUnique({
    where: { id: propertyId, orgId: guarded.orgId },
    select: { id: true, legalEntityId: true, orgId: true, quietHoursStart: true, quietHoursEnd: true },
  })
  if (!property) return { error: 'That property no longer exists.' }
  await requirePermission('template.write', propertyResource(property))

  const start = parseHour(formData.get('quietHoursStart'))
  const end = parseHour(formData.get('quietHoursEnd'))
  if (start === null || end === null) return { error: 'Pick a start and an end hour.' }
  if ((start === 'default') !== (end === 'default')) {
    return { error: 'Set both hours, or put both back to the default.' }
  }
  if (start !== 'default' && start === end) {
    return { error: 'The start and end must differ, or there would be no quiet hours at all.' }
  }

  const after =
    start === 'default' || end === 'default'
      ? { quietHoursStart: null, quietHoursEnd: null }
      : { quietHoursStart: start, quietHoursEnd: end }
  await prisma.$transaction(async (tx) => {
    await tx.property.update({ where: { id: property.id }, data: after })
    await audit(
      {
        action: 'property.updated',
        entityType: 'Property',
        entityId: property.id,
        before: { quietHoursStart: property.quietHoursStart, quietHoursEnd: property.quietHoursEnd },
        after,
      },
      tx,
    )
  })

  revalidatePath('/messages/settings')
  return { notice: 'Quiet hours saved.' }
}
