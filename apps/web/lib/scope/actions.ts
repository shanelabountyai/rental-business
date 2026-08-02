'use server'

import { cookies } from 'next/headers'
import { SCOPE_COOKIE } from './current-scope.ts'

/**
 * Stores the property-switcher selection.
 *
 * Deliberately does no validation: the cookie is a preference, not a
 * permission, and `currentScope` intersects whatever it says with what R-004
 * allows on every request. Validating here as well would imply the value is
 * trusted somewhere, which is exactly the belief that turns a filter into a
 * privilege-escalation path.
 */
export async function selectScope(value: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(SCOPE_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 90,
  })
}
