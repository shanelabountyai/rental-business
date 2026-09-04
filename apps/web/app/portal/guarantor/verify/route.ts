import { redirect } from 'next/navigation'
import type { NextRequest } from 'next/server'
import { signIn } from '@/auth.ts'

export const runtime = 'nodejs'

/**
 * Where a guarantor's magic link lands (R-165). Same shape as
 * /portal/verify - see that route's own comment for why a GET that mutates
 * state is correct here.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token) redirect('/portal/guarantor/login?error=missing')

  try {
    await signIn('guarantor-magic-link', { token, redirectTo: '/portal/guarantor' })
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect('/portal/guarantor/login?error=invalid')
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
