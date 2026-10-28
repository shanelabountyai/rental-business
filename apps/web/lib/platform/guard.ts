import { stepUpIsFresh } from '@rental/core/auth'
import { type PlatformPermission, canPlatform } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { redirect } from 'next/navigation'
import { type PlatformPrincipal, currentPlatformPrincipal } from '@/platform-auth.ts'

/**
 * The console's guard (PRD 11 §2, R-294b): a platform session or the platform
 * sign-in page. It reads only the `__Host-platform` cookie, so an org staff
 * session - which is a different cookie on a different host - is anonymous
 * here. A session exists only after a code was proved, so reaching this means
 * MFA is enrolled and verified (PADM-02).
 *
 * `permission` (§3.3, R-302a) is decided by `canPlatform` over the admin's
 * live assignments, read here on every call: a revoke takes effect on the
 * next press, not at the next sign-in. Without one, only a session is wanted -
 * the admin's own account pages, which every admin may reach.
 *
 * `stepUp` (§2.4, R-294c) additionally wants a code proved within the last
 * ten minutes, and sends the admin to `/platform/step-up` to prove one, then
 * back to `next`. A step-up PERMISSION (§3.1) wants the same without being
 * asked. Pass the PAGE the action was pressed on, not the action: the admin
 * presses again on return, which is the point - the code authorises a press
 * they can see, never one replayed behind their back.
 *
 * `view` (R-302b, D-367) is for a PAGE behind a step-up permission: holding it
 * is enough to look, and the code is asked for on the press. Without it
 * `/platform/admins` would want a fresh code every ten minutes just to read.
 */
export async function requirePlatform(
  options: { permission?: PlatformPermission; stepUp?: boolean; view?: boolean; next?: string } = {},
): Promise<PlatformPrincipal> {
  const principal = await currentPlatformPrincipal()
  if (!principal) redirect('/platform/login')
  const toStepUp = () => redirect(`/platform/step-up?next=${encodeURIComponent(options.next ?? '/platform')}`)

  if (options.permission) {
    const decision = await platformDecision(principal, options.permission)
    // `canPlatform` answers no_permission first, so stepup_required means held.
    if (!decision.allowed && !(options.view && decision.reason === 'stepup_required')) {
      if (decision.reason === 'stepup_required') toStepUp()
      redirect(`/platform/no-access?permission=${encodeURIComponent(options.permission)}`)
    }
  }
  if (options.stepUp && !stepUpIsFresh(principal.mfaVerifiedAt)) toStepUp()
  return principal
}

/// `canPlatform` over the admin's live assignments, read on every call. For a
/// page that shows a panel only to holders (the dashboard, R-303) as well as
/// for the guard above.
export async function platformDecision(principal: PlatformPrincipal, permission: PlatformPermission) {
  const assignments = await prisma.platformRoleAssignment.findMany({
    where: { platformAdminId: principal.id, revokedAt: null },
    select: { roleKey: true, role: { select: { permissions: true } } },
  })
  return canPlatform(
    {
      // The session callback already refused an inactive admin.
      active: true,
      mfaVerifiedAt: principal.mfaVerifiedAt,
      assignments: assignments.map((a) => ({ roleKey: a.roleKey, permissions: a.role.permissions })),
    },
    permission,
  )
}
