import 'server-only'

import { prisma } from '@rental/db'

// The deployment's messaging settings (R-266, PRD 08 B5): one row until
// R-285 makes it one per organisation. Quiet hours are per property and read
// through `quietHoursOf` instead.

export const COMPANY_NAME = 'Rental Operations'

// R-285b: one row per organisation, keyed by `orgId` (unique).
export async function messagingSettings(orgId: string): Promise<{
  businessName: string
  replyTaskAssigneeStaffId: string | null
}> {
  const row = await prisma.messagingSettings.findUnique({ where: { orgId } })
  return {
    businessName: row?.businessName ?? COMPANY_NAME,
    replyTaskAssigneeStaffId: row?.replyTaskAssigneeStaffId ?? null,
  }
}

/// The configured reply assignee, but only while they are active and hold
/// `task.write` over this property. A Task assigned to somebody who cannot
/// see it drops off everybody else's My Day too, so anyone else is null.
export async function replyTaskAssignee(property: {
  id: string
  legalEntityId: string
  orgId: string
}): Promise<string | null> {
  const { replyTaskAssigneeStaffId: staffUserId } = await messagingSettings(property.orgId)
  if (!staffUserId) return null
  const grant = await prisma.staffAssignment.findFirst({
    where: {
      // A portfolio-wide grant is the property's org's, never another's.
      orgId: property.orgId,
      staffUserId,
      revokedAt: null,
      staffUser: { active: true },
      role: { permissions: { has: 'task.write' } },
      OR: [
        { propertyId: property.id },
        { propertyId: null, legalEntityId: property.legalEntityId },
        { propertyId: null, legalEntityId: null },
      ],
    },
    select: { id: true },
  })
  return grant ? staffUserId : null
}
