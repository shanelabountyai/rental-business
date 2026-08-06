import { VendorJob } from '@/components/vendors/vendor-job.tsx'
import {
  markWorkComplete,
  respondToWorkOrder,
  revealCodeForVendor,
  uploadVendorDocument,
} from '@/lib/vendors/actions.ts'
import { vendorRejectionMessage } from '@/lib/vendors/messages.ts'
import { verifyVendorLink } from '@/lib/vendors/link.ts'
import { vendorJobContext } from '@/lib/vendors/queries.ts'

export const metadata = {
  title: 'Your job',
  // A magic link in a text message must never be indexed, and the URL itself
  // is the credential (D-16) - so this is not merely tidy, it is part of the
  // control set.
  robots: { index: false, follow: false },
}

// The zero-login vendor surface (D-6, D-16, MAINT-03, R-025).
//
// PUBLIC BY DESIGN: no session, no account, no RBAC. The token in the path
// is the entire credential, and `verifyVendorLink()` is the entire
// authorization - see lib/vendors/link.ts's header for the control set that
// makes a multi-use bearer token defensible, and D-16 for why single-use was
// the wrong shape here. This route is listed in route-guards.test.ts's
// PUBLIC_ROUTES with that reasoning attached.

export const dynamic = 'force-dynamic'

export default async function VendorLinkPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const link = await verifyVendorLink(token)

  if (!link.ok) {
    // A plain, unstyled dead end that says which problem this is. NOT a
    // redirect to a sign-in page: there is no account to sign into, and
    // sending a plumber to a login screen is exactly the experience D-6
    // exists to avoid.
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">This link isn&rsquo;t working</h1>
        <p className="text-sm">{vendorRejectionMessage(link.reason)}</p>
      </main>
    )
  }

  const { workOrder } = link
  const context = await vendorJobContext(workOrder)

  const address = [
    workOrder.property.addressLine1,
    workOrder.property.city,
    workOrder.property.state,
    workOrder.property.postalCode,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <VendorJob
      job={{
        scope: workOrder.scope,
        priority: workOrder.priority,
        propertyName: workOrder.property.name,
        address,
        unitName: workOrder.unit.name,
        tenantFirstName: workOrder.ticket?.tenant?.firstName ?? null,
        tenantPhone: workOrder.ticket?.tenant?.phone ?? null,
        ticketDescription: workOrder.ticket?.description ?? null,
        vendorResponse: workOrder.vendorResponse,
        status: workOrder.status,
        proposedStart: workOrder.proposedStart?.toISOString().slice(0, 16).replace('T', ' ') ?? null,
        proposedEnd: workOrder.proposedEnd?.toISOString().slice(0, 16).replace('T', ' ') ?? null,
        invoiceUploaded: context.photos.some((p) => p.type === 'INVOICE'),
      }}
      photos={context.photos.map((p) => ({
        id: p.id,
        fileName: p.fileName,
        // Through the vendor's OWN token-scoped route, not the staff/tenant
        // one - a vendor has no session for that route to authorize.
        href: `/vendor/${token}/documents/${p.id}`,
      }))}
      appliances={context.appliances}
      accessCodes={context.accessCodes}
      shutoffs={context.shutoffs}
      respondAction={respondToWorkOrder.bind(null, token)}
      uploadAction={uploadVendorDocument.bind(null, token)}
      completeAction={markWorkComplete.bind(null, token)}
      revealAction={revealCodeForVendor.bind(null, token)}
    />
  )
}
