import { stepUpIsFresh } from '@rental/core/auth'
import { redirect } from 'next/navigation'
import { type PlatformPrincipal, currentPlatformPrincipal } from '@/platform-auth.ts'

/**
 * The console's guard (PRD 11 §2, R-294b): a platform session or the platform
 * sign-in page. It reads only the `__Host-platform` cookie, so an org staff
 * session - which is a different cookie on a different host - is anonymous
 * here. A session exists only after a code was proved, so reaching this means
 * MFA is enrolled and verified (PADM-02).
 *
 * `stepUp` (§2.4, R-294c) additionally wants a code proved within the last
 * ten minutes, and sends the admin to `/platform/step-up` to prove one, then
 * back to `next`. Pass the PAGE the action was pressed on, not the action:
 * the admin presses again on return, which is the point - the code authorises
 * a press they can see, never one replayed behind their back.
 *
 * R-302 adds the permission argument (`canPlatform`) in front of the options.
 */
export async function requirePlatform(
  options: { stepUp?: false } | { stepUp: true; next: string } = {},
): Promise<PlatformPrincipal> {
  const principal = await currentPlatformPrincipal()
  if (!principal) redirect('/platform/login')
  if (options.stepUp && !stepUpIsFresh(principal.mfaVerifiedAt)) {
    redirect(`/platform/step-up?next=${encodeURIComponent(options.next)}`)
  }
  return principal
}
