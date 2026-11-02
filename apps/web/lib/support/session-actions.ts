'use server'

import { headers } from 'next/headers'
import { clearSupportCookie } from '@/lib/support/cookie.ts'
import { endGrantAsPlatform } from '@/lib/support/grants.ts'
import { currentSupportSession } from '@/lib/support/session.ts'

// The support session's own two presses, on the org's host (PRD 11 §4.7,
// R-295b). Each is the session acting on itself - it can only end or drop
// access, never gain any - so the session is the whole guard, as "sign out"
// is. Neither redirects (D-379): each answers its form in place.

export interface SupportSessionFormState {
  error?: string
  notice?: string
}

/// The banner's "End now": ends the grant itself, as the console's would, so
/// the next request on this cookie lands on `/support/ended`.
export async function endSupportSession(
  _previous: SupportSessionFormState,
  _formData: FormData,
): Promise<SupportSessionFormState> {
  const session = await currentSupportSession()
  if (!session?.live) return { error: 'There is no open support session here.' }
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const { grantId, orgId, adminId } = session.claims
  const ended = await endGrantAsPlatform(grantId, orgId, adminId, ip)
  return ended
    ? { notice: 'Support session ended. Nothing more can be viewed under this grant.' }
    : { error: 'This grant had already closed.' }
}

/// `/support/ended`'s "Leave": drops this browser's cookie, after which the
/// host treats it as signed out. Touches no row.
export async function leaveSupportSession(
  _previous: SupportSessionFormState,
  _formData: FormData,
): Promise<SupportSessionFormState> {
  if (!(await currentSupportSession())) return { error: 'There is no support session here to leave.' }
  await clearSupportCookie()
  return { notice: 'You have left the support session. You can close this tab.' }
}
