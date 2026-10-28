import { decode, encode } from 'next-auth/jwt'
import type { NextRequest, NextResponse } from 'next/server'

// The platform session's cookie and idle window, and the proxy's roll of it
// (PRD 11 §2.3, R-294b). Free of Prisma so the proxy can import it.
//
// WHY THE PROXY ROLLS IT. The idle limit is the JWT's own 30-minute expiry,
// and Auth.js re-issues the cookie only from a route handler or a server
// action - a server component cannot write cookies. Reading console pages
// would therefore never count as activity, and an admin would be signed out
// 30 minutes after their last ACTION however much they were reading. Here the
// cookie is re-sealed on every console GET. Nothing is validated here; the jwt
// callback does that on the request itself, against the database. An expired
// or forged cookie fails `decode` and is left alone.

export const PLATFORM_SESSION_COOKIE = '__Host-platform.session-token'
export const PLATFORM_IDLE_SECONDS = 30 * 60

export async function rollPlatformSession(
  request: NextRequest,
  response: NextResponse,
): Promise<void> {
  // GET only: a POST is a server action that may itself be writing this
  // cookie - signing out - and two Set-Cookie headers for one name race.
  if (request.method !== 'GET') return
  const value = request.cookies.get(PLATFORM_SESSION_COOKIE)?.value
  const secret = process.env.AUTH_SECRET
  if (!value || !secret) return
  const salt = PLATFORM_SESSION_COOKIE
  const token = await decode({ token: value, secret, salt }).catch(() => null)
  if (!token) return
  response.cookies.set(
    PLATFORM_SESSION_COOKIE,
    await encode({ token, secret, salt, maxAge: PLATFORM_IDLE_SECONDS }),
    { httpOnly: true, sameSite: 'lax', path: '/', secure: true, maxAge: PLATFORM_IDLE_SECONDS },
  )
}
