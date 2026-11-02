import 'server-only'

import { decode, encode } from 'next-auth/jwt'
import { cookies, headers } from 'next/headers'

// The support session's cookie (PRD 11 §4.7, R-295b): a third session, sealed
// with AUTH_SECRET like the other two but under its own salt, so a staff or
// platform token can never be opened as one. `__Host-`: a browser refuses to
// set it with a Domain attribute, so it lives on the grant's org host and no
// other. Its own module so the invariant suites can stand in for the browser.

export const SUPPORT_SESSION_COOKIE = '__Host-support.session'

/// What the cookie proves: this browser redeemed an entry token for this
/// grant, at `issuedAt`. Validity is re-read from the grant on every request.
export interface SupportClaims {
  grantId: string
  adminId: string
  orgId: string
  issuedAt: number
}

function secret(): string {
  const value = process.env.AUTH_SECRET
  if (!value) throw new Error('AUTH_SECRET is not set; a support session cannot be sealed.')
  return value
}

export async function sealSupportClaims(claims: SupportClaims, maxAgeSeconds: number): Promise<string> {
  return encode({ token: { ...claims }, secret: secret(), salt: SUPPORT_SESSION_COOKIE, maxAge: maxAgeSeconds })
}

/// The claims, or null for no cookie, a forged one, or one past its own expiry.
/// Read off the request's own `Cookie` header rather than `cookies()`: the
/// same bytes, and every suite that stands in for `next/headers` already
/// gives `headers()` - a request without the cookie is simply no session.
export async function readSupportClaims(): Promise<SupportClaims | null> {
  const value = (await headers())
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SUPPORT_SESSION_COOKIE}=`))
    ?.slice(SUPPORT_SESSION_COOKIE.length + 1)
  if (!value || !process.env.AUTH_SECRET) return null
  const token = await decode({ token: value, secret: secret(), salt: SUPPORT_SESSION_COOKIE }).catch(() => null)
  const { grantId, adminId, orgId, issuedAt } = (token ?? {}) as Partial<SupportClaims>
  return typeof grantId === 'string' && typeof adminId === 'string' && typeof orgId === 'string' && typeof issuedAt === 'number'
    ? { grantId, adminId, orgId, issuedAt }
    : null
}

/// What the cookie is set with. A `__Host-` cookie is refused unless Secure
/// with Path=/ and no Domain, and that includes the expired copy that clears it.
export const SUPPORT_COOKIE_OPTIONS = { httpOnly: true, sameSite: 'lax', path: '/', secure: true } as const

export async function clearSupportCookie(): Promise<void> {
  ;(await cookies()).set(SUPPORT_SESSION_COOKIE, '', { ...SUPPORT_COOKIE_OPTIONS, maxAge: 0 })
}
