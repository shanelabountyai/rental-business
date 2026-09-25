import { redirect } from 'next/navigation'
import { MagicLinkConfirm } from '@/components/portal/magic-link-confirm.tsx'

// Per request, for the CSP nonce - see portal/login/page.tsx for why.
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Continue to your home — Rental Operations',
  robots: { index: false, follow: false },
}

// Where a tenant's emailed or texted sign-in link lands. GET changes nothing;
// the button posts to /portal/verify/redeem (K1, lib/auth/redeem-magic-link.ts).
export default async function TenantVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  if (!token) redirect('/portal/login?error=missing')
  return (
    <MagicLinkConfirm
      token={token}
      action="/portal/verify/redeem"
      title="Continue to your home"
      description="Press the button to finish signing in. This link works once, so press it yourself rather than forwarding it."
    />
  )
}
