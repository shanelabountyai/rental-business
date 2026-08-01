import { redirect } from 'next/navigation'
import type { NextRequest } from 'next/server'
import { signIn } from '@/auth.ts'

export const runtime = 'nodejs'

/**
 * Where a tenant's magic link lands. The token is redeemed inside the
 * `tenant-magic-link` provider, which burns it and issues the session.
 *
 * A GET that mutates state is normally wrong, but a link in an email can only
 * ever be a GET, and this is the one case where that is the whole point. The
 * mitigations are that the token is single-use, short-lived, and useless once
 * redeemed - so an email prefetcher that follows the link costs the tenant one
 * "request a new link", not their account.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token) redirect('/portal/login?error=missing')

  try {
    await signIn('tenant-magic-link', { token, redirectTo: '/portal' })
  } catch (error) {
    // Auth.js signals a successful redirect by throwing NEXT_REDIRECT; only a
    // genuine failure should land the tenant back on the sign-in page.
    if (isRedirectError(error)) throw error
    redirect('/portal/login?error=invalid')
  }
}

function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  )
}
