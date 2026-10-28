import { stepUpIsFresh } from '../auth/step-up.ts'

// The platform console's permission vocabulary (PRD 11 §3, R-302a, D-349).
//
// A SEPARATE CLOSED SET FROM `PERMISSIONS`, sharing no string with it (a unit
// test enforces that), so an org grant can never satisfy a platform check
// through a type that widened to `string`. A platform admin holds no `Actor`
// and no `Permission`; an org actor holds no `PlatformPermission`.
//
// PRD 11 §3.1 spelled the audit permission `audit.read`, which the org
// catalogue already holds - the disjointness test caught it on its first run.
// It is `platformAudit.read`, matching `platformAdmin.manage` (D-366).

export const PLATFORM_PERMISSIONS = [
  'org.read',
  'org.create',
  'org.configure',
  'org.freeze',
  'org.offboard',
  'org.feeSet',
  'integration.provision',
  'grant.request',
  'grant.breakGlass',
  'job.rerun',
  'jurisdiction.publish',
  'platformAudit.read',
  'platformAdmin.manage',
] as const

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number]

const PLATFORM_PERMISSION_SET: ReadonlySet<string> = new Set(PLATFORM_PERMISSIONS)

export function isPlatformPermission(value: string): value is PlatformPermission {
  return PLATFORM_PERMISSION_SET.has(value)
}

/// §3.1's step-up column: these want a code proved within ten minutes on
/// every press. `org.configure`'s kill switch is a step-up ACT inside a
/// permission that is not, so its action asks for `stepUp: true` itself.
export const PLATFORM_STEP_UP_PERMISSIONS: ReadonlySet<PlatformPermission> = new Set([
  'org.create',
  'org.freeze',
  'org.offboard',
  'org.feeSet',
  'grant.breakGlass',
  'jurisdiction.publish',
  'platformAdmin.manage',
])

export type PlatformRoleKey = 'platform_owner' | 'platform_support' | 'platform_viewer'

/**
 * The seeded platform roles (§3.2, D-351). Rows, like org roles (D-5): this
 * constant is what `seed.mts` writes, and `canPlatform()` reads the
 * permissions carried on the admin's assignments, never this object.
 *
 * Money, lifecycle, access and law are owner-only BY NOT BEING ON ANOTHER
 * LIST, the way `confidential.read` is owner-only on the org side - never by
 * a test on a role's name.
 */
export const PLATFORM_ROLE_DEFINITIONS: Record<
  PlatformRoleKey,
  { name: string; permissions: readonly PlatformPermission[] }
> = {
  platform_owner: { name: 'Platform owner', permissions: PLATFORM_PERMISSIONS },
  platform_support: {
    name: 'Platform support',
    permissions: ['org.read', 'integration.provision', 'grant.request', 'grant.breakGlass', 'job.rerun', 'platformAudit.read'],
  },
  platform_viewer: { name: 'Platform viewer', permissions: ['org.read', 'platformAudit.read'] },
}

export interface PlatformAdminActor {
  active: boolean
  /// When a code was last proved (sign-in or step-up), epoch ms.
  mfaVerifiedAt: number
  /// Live assignments only, each with its role's permissions resolved.
  assignments: readonly { roleKey: string; permissions: readonly string[] }[]
}

export type PlatformDenial = 'inactive' | 'no_permission' | 'stepup_required'

export type PlatformDecision = { allowed: true } | { allowed: false; reason: PlatformDenial }

/**
 * §3.3, the D-5 discipline restated for the console: inactive, then "does some
 * live assignment's role carry it", then the step-up window. Nothing else - no
 * owner flag, no role-name test, no wildcard.
 */
export function canPlatform(
  admin: PlatformAdminActor,
  permission: PlatformPermission,
  now = Date.now(),
): PlatformDecision {
  if (!admin.active) return { allowed: false, reason: 'inactive' }
  if (!admin.assignments.some((a) => a.permissions.includes(permission))) {
    return { allowed: false, reason: 'no_permission' }
  }
  if (PLATFORM_STEP_UP_PERMISSIONS.has(permission) && !stepUpIsFresh(admin.mfaVerifiedAt, now)) {
    return { allowed: false, reason: 'stepup_required' }
  }
  return { allowed: true }
}

export interface PlatformAssignmentSummary {
  id: string
  platformAdminId: string
  roleKey: string
  revokedAt: Date | null
  /// Whether the admin holding it is active; a deactivated owner's live
  /// assignment keeps nobody able to get in.
  adminActive: boolean
}

function liveOwners(assignments: readonly PlatformAssignmentSummary[]) {
  return assignments.filter((a) => a.roleKey === 'platform_owner' && a.revokedAt === null && a.adminActive)
}

export const LAST_PLATFORM_OWNER =
  'This is the last platform owner. Add another owner before removing this one.'

/**
 * Why this revoke must be refused, or null (§3.3). A pure function over the
 * WHOLE list passed as a value, as `revokeRefusal` is: the rule is about the
 * deployment, so it is tested with lists, not against the shared database.
 * The deferred trigger in the migration is the guarantee; this is the message.
 *
 * Revoking your OWN assignment is allowed here, unless it is the last owner:
 * that is §3.3's one exception to "nobody edits their own assignments", so a
 * departing owner can leave. Granting to yourself is `platformGrantRefusal`.
 */
export function platformRevokeRefusal(
  assignmentId: string,
  assignments: readonly PlatformAssignmentSummary[],
): string | null {
  const target = assignments.find((a) => a.id === assignmentId)
  if (!target) return 'That assignment no longer exists.'
  if (target.revokedAt !== null) return 'That assignment was already revoked.'
  const owners = liveOwners(assignments)
  if (owners.length === 1 && owners[0]!.id === target.id) {
    return LAST_PLATFORM_OWNER
  }
  return null
}

/// Granting: never to yourself (§3.3; foundation INV-28 is that only a holder
/// of `platformAdmin.manage` grants at all, which the guard enforces).
export function platformGrantRefusal(targetAdminId: string, actorId: string): string | null {
  return targetAdminId === actorId ? 'You cannot change your own roles. Ask another platform owner.' : null
}

/// Deactivating: never yourself (it ends this session before you could undo
/// it, as `deactivationRefusal` reasons), and never the last owner.
export function platformDeactivationRefusal(
  targetAdminId: string,
  actorId: string,
  assignments: readonly PlatformAssignmentSummary[],
): string | null {
  if (targetAdminId === actorId) return 'You cannot deactivate your own account. Ask another platform owner.'
  const owners = liveOwners(assignments)
  if (owners.length > 0 && owners.every((a) => a.platformAdminId === targetAdminId)) return LAST_PLATFORM_OWNER
  return null
}
