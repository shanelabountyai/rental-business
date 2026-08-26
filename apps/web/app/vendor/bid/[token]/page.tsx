import { BidForm } from '@/components/vendors/bid-form.tsx'
import { VendorHelpLine } from '@/components/vendors/vendor-help-line.tsx'
import { submitBid } from '@/lib/vendors/bid-actions.ts'
import { verifyBidLink } from '@/lib/vendors/bids.ts'

export const metadata = {
  title: 'Quote request',
  // Same reasoning as the dispatch page: the URL is the credential.
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

// The zero-login BID surface (MAINT-04, D-6, R-026).
//
// PUBLIC BY DESIGN, exactly like /vendor/[token] - the token in the path is
// the whole credential and verifyBidLink() is the whole authorization. It is
// a separate token purpose from the dispatch link so that N vendors can hold
// live links to one work order at once without weakening D-16's
// one-live-dispatch-link-per-work-order invariant. Listed in
// route-guards.test.ts's PUBLIC_ROUTES with that reasoning.
export default async function VendorBidPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const link = await verifyBidLink(token)

  if (!link.ok) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">This link isn&rsquo;t working</h1>
        <p className="text-base">
          {link.reason === 'not_actionable'
            ? 'This job has already been assigned. Thanks for looking.'
            : 'This link is not valid. Check for a newer message from us.'}
        </p>
        {/* The dispatch page's dead end has offered a number since R-098; this
            one, added by the same programme, still printed the sentence that
            component was written to replace (R-114). */}
        <VendorHelpLine />
      </main>
    )
  }

  const { bid } = link
  const address = [
    bid.workOrder.property.addressLine1,
    bid.workOrder.property.city,
    bid.workOrder.property.state,
    bid.workOrder.property.postalCode,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <BidForm
      job={{
        scope: bid.workOrder.scope,
        address,
        unitName: bid.workOrder.unit.name,
        description: bid.workOrder.ticket?.description ?? null,
      }}
      action={submitBid.bind(null, token)}
      alreadyAnswered={bid.respondedAt != null}
    />
  )
}
