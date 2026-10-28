import { redirect } from 'next/navigation'
import { type PlatformPrincipal, currentPlatformPrincipal } from '@/platform-auth.ts'

/**
 * The console's guard (PRD 11 §2, R-294b): a platform session or the platform
 * sign-in page. It reads only the `__Host-platform` cookie, so an org staff
 * session - which is a different cookie on a different host - is anonymous
 * here. A session exists only after a code was proved, so reaching this means
 * MFA is enrolled and verified (PADM-02).
 *
 * R-302 adds the permission argument (`canPlatform`) and R-294c the step-up
 * option; both slot in here, so every console page already calls the one
 * function they will extend.
 */
export async function requirePlatform(): Promise<PlatformPrincipal> {
  const principal = await currentPlatformPrincipal()
  if (!principal) redirect('/platform/login')
  return principal
}
