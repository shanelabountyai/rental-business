import type { RoleKey } from '@rental/core/rbac'

// The two ways an owner can lock the business out of its own deployment, as
// pure predicates so they can be tested without a session (R-138).
//
// There is no superuser and no back door (D-5), so "no active owner
// assignment" is not a degraded state that support can fix - it is a
// deployment whose only remaining route back in is `db:create-owner --force`
// on the server. Both rules below are therefore refusals at the trust
// boundary, not warnings.

export interface AssignmentSummary {
  id: string
  staffUserId: string
  roleKey: string
  revokedAt: Date | null
}

/// Assignments that grant something right now. `revokeAssignment` writes a
/// timestamp rather than deleting (ROLE-06), so "active" is the filter, never
/// the row count.
export function activeOwnerAssignments(
  assignments: readonly AssignmentSummary[],
): AssignmentSummary[] {
  return assignments.filter((a) => a.roleKey === 'owner' && a.revokedAt === null)
}

/**
 * Why this revoke must be refused, or null if it may proceed.
 *
 * Self-revocation is allowed as long as it is not the LAST owner grant: a
 * two-owner business demoting one of them is ordinary, and refusing every
 * self-edit would mean an owner cannot correct their own over-broad grant.
 */
export function revokeRefusal(
  assignmentId: string,
  assignments: readonly AssignmentSummary[],
): string | null {
  const target = assignments.find((a) => a.id === assignmentId)
  if (!target) return 'That assignment no longer exists.'
  if (target.revokedAt !== null) return 'That assignment was already revoked.'

  const owners = activeOwnerAssignments(assignments)
  if (target.roleKey === 'owner' && owners.length <= 1) {
    return 'This is the last owner assignment. Grant another owner before revoking this one — there is no superuser and no way back in without a server script (D-5).'
  }
  return null
}

/**
 * Why this deactivation must be refused, or null if it may proceed.
 *
 * Deactivating yourself is refused outright rather than conditionally. Unlike
 * a revoke it takes effect on the actor's own session within a minute
 * (`sessionsValidFrom`), so the mis-click ends the session that would undo it.
 */
export function deactivationRefusal(
  targetStaffUserId: string,
  actorStaffUserId: string,
  assignments: readonly AssignmentSummary[],
): string | null {
  if (targetStaffUserId === actorStaffUserId) {
    return 'You cannot deactivate your own account — it would end this session before you could undo it. Ask another owner.'
  }
  const owners = activeOwnerAssignments(assignments)
  if (owners.length > 0 && owners.every((a) => a.staffUserId === targetStaffUserId)) {
    return 'This is the only active owner. Grant another owner before deactivating this one.'
  }
  return null
}

export const STAFF_ROLE_KEYS = [
  'owner',
  'manager',
  'maintenance_tech',
  'read_only',
] as const satisfies readonly RoleKey[]

/// `tenant` and `guarantor` are roles (D-5) but are held by Tenant actors.
/// Granting one to a StaffUser makes a login `requireStaff()` admits and every
/// permission check then refuses - the same refusal `db:create-owner` carries.
export function isStaffRoleKey(value: string): value is (typeof STAFF_ROLE_KEYS)[number] {
  return (STAFF_ROLE_KEYS as readonly string[]).includes(value)
}
