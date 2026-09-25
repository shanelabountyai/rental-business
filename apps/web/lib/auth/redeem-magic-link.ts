import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { signIn } from '@/auth.ts'

/**
 * Redeems a tenant or guarantor magic link - on a POST, never a GET (K1).
 *
 * This used to be a GET route, defended in its own comment as "a link in an
 * email can only ever be a GET". That is true and is exactly the problem:
 * mail scanners and link previews follow every GET, and the token is
 * single-use, so the tenant's own click found a spent link. The login page
 * even had a banner apologising for it. The email now lands on a page that
 * changes nothing (`/portal/verify`), and the button on that page POSTs here.
 *
 * The redirect is a 303 built here rather than Auth.js's own, because a
 * route handler's `redirect()` is a 307 and a 307 after a POST re-POSTs to
 * the destination page.
 */
export async function redeemMagicLink(
  request: NextRequest,
  opts: { provider: string; destination: string; loginPath: string },
): Promise<NextResponse> {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), 303)

  const form = await request.formData().catch(() => null)
  const token = form?.get('token')
  if (typeof token !== 'string' || !token) return to(`${opts.loginPath}?error=missing`)

  try {
    const result = await signIn(opts.provider, { token, redirect: false })
    // With `redirect: false` a refused credential comes back as a URL that
    // carries the error rather than as a throw, on some Auth.js versions.
    if (typeof result === 'string' && new URL(result, request.url).searchParams.has('error')) {
      return to(`${opts.loginPath}?error=invalid`)
    }
  } catch {
    return to(`${opts.loginPath}?error=invalid`)
  }
  return to(opts.destination)
}
