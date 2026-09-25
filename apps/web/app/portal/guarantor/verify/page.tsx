import { redirect } from 'next/navigation'
import { MagicLinkConfirm } from '@/components/portal/magic-link-confirm.tsx'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Continue to your guarantor page — Rental Operations',
  robots: { index: false, follow: false },
}

// Guarantor twin of /portal/verify (R-165, K1): GET changes nothing.
export default async function GuarantorVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  if (!token) redirect('/portal/guarantor/login?error=missing')
  return (
    <MagicLinkConfirm
      token={token}
      action="/portal/guarantor/verify/redeem"
      title="Continue to your guarantor page"
      description="Press the button to finish signing in. This link works once, so press it yourself rather than forwarding it."
    />
  )
}
