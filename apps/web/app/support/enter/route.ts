import { type NextRequest, NextResponse } from 'next/server'
import { hostOrgId } from '@/lib/auth/org.ts'
import { SUPPORT_COOKIE_OPTIONS, SUPPORT_SESSION_COOKIE, sealSupportClaims } from '@/lib/support/cookie.ts'
import { enterSupportSession } from '@/lib/support/session.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Where the console's "Open" lands (PRD 11 §4.7, R-295b), on the grant's org
// host. A GET, unlike a tenant's magic link (K1), because this link is never
// mailed: the console's own page sends the browser here within its 60
// seconds, so no scanner sees it first. Relative `Location`s, never AUTH_URL's
// host: the cookie is this host's and must stay with the browser (D-379).
export async function GET(request: NextRequest) {
  const entered = await enterSupportSession(request.nextUrl.searchParams.get('token') ?? '', await hostOrgId(), {
    ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
  })
  const response = new NextResponse(null, { status: 303, headers: { location: entered ? '/dashboard' : '/support/ended' } })
  if (entered) {
    response.cookies.set(SUPPORT_SESSION_COOKIE, await sealSupportClaims(entered.claims, entered.maxAgeSeconds), {
      ...SUPPORT_COOKIE_OPTIONS,
      maxAge: entered.maxAgeSeconds,
    })
  }
  return response
}
