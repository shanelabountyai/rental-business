import 'server-only'

import { recordAudit } from '@rental/core/audit'
import { prisma } from '@rental/db'
import { currentAuditActor } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'

// Granting and revoking access. R-004 built the tables and the check; this
// closes the gap it left open - a permission change is on ROLE-03's privileged
// list and had nowhere to be recorded until the audit service existed.
//
// R-007 builds the screen. These are the functions it should call, rather than
// writing StaffAssignment rows directly, because the audit entry and the grant
// are one transaction here and would not be there.

export interface AssignmentScope {
  propertyId?: string | null
  legalEntityId?: string | null
}

/**
 * Grants a role over a scope.
 *
 * `staff.manage` is MFA-gated (R-004), so the caller has already proved a
 * second factor by the time this runs - which is the point: handing someone
 * the keys is exactly the action ROLE-05 wants a second factor in front of.
 */
export async function grantAssignment(
  staffUserId: string,
  roleKey: string,
  scope: AssignmentScope = {},
) {
  const grantor = await requirePermission('staff.manage', {
    propertyId: scope.propertyId,
    legalEntityId: scope.legalEntityId,
  })
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  const actor = await currentAuditActor()

  return prisma.$transaction(async (tx) => {
    const assignment = await tx.staffAssignment.create({
      data: {
        staffUserId,
        roleId: role.id,
        propertyId: scope.propertyId ?? null,
        legalEntityId: scope.legalEntityId ?? null,
        grantedByStaffId: grantor.id,
      },
    })

    // Same transaction as the grant. If the entry cannot be written the grant
    // does not happen, which is the only ordering where the log can neither
    // claim something that did not happen nor miss something that did.
    await recordAudit(tx, {
      actor,
      action: 'staff.assignment_granted',
      entityType: 'StaffUser',
      entityId: staffUserId,
      propertyId: scope.propertyId ?? null,
      after: {
        roleKey,
        propertyId: assignment.propertyId,
        legalEntityId: assignment.legalEntityId,
        grantedByStaffId: grantor.id,
      },
    })

    return assignment
  })
}

/**
 * Revokes a grant. A timestamp, never a delete - ROLE-06 requires that
 * deactivation preserve all history, and the revoked row is the evidence that
 * the access existed at all.
 *
 * Takes effect on the next request: R-004 reads assignments per request, so
 * there is nothing to invalidate.
 */
export async function revokeAssignment(assignmentId: string, reason?: string) {
  const existing = await prisma.staffAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
    include: { role: { select: { key: true } } },
  })
  await requirePermission('staff.manage', {
    propertyId: existing.propertyId,
    legalEntityId: existing.legalEntityId,
  })
  const actor = await currentAuditActor()

  return prisma.$transaction(async (tx) => {
    const revoked = await tx.staffAssignment.update({
      where: { id: assignmentId },
      data: { revokedAt: new Date() },
    })

    await recordAudit(tx, {
      actor,
      action: 'staff.assignment_revoked',
      entityType: 'StaffUser',
      entityId: existing.staffUserId,
      propertyId: existing.propertyId,
      before: { roleKey: existing.role.key, revokedAt: null },
      after: { roleKey: existing.role.key, revokedAt: revoked.revokedAt },
      reason,
    })

    return revoked
  })
}
