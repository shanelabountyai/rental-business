import { utcToWallClock } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { VendorJob } from '@/components/vendors/vendor-job.tsx'
import {
  markWorkComplete,
  respondToWorkOrder,
  revealCodeForVendor,
  sendVendorMessage,
  uploadVendorDocument,
} from '@/lib/vendors/actions.ts'
import { VendorHelpLine } from '@/components/vendors/vendor-help-line.tsx'
import { vendorRejectionMessage } from '@/lib/vendors/messages.ts'
import { verifyVendorLink } from '@/lib/vendors/link.ts'
import { vendorJobContext } from '@/lib/vendors/queries.ts'
import { vendorWorkOrderThread } from '@/lib/workorders/timeline.ts'

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
        <h1 className="text-2xl font-semibold">This link isn&rsquo;t working</h1>
        <p className="text-base">{vendorRejectionMessage(link.reason)}</p>
        {/* EVERY dead end here said "call the office" and gave no number.
            The token is invalid so there is no property to look up - this is
            one operations number, and a `tel:` link so it dials on the phone
            the vendor is already holding. A link expiring three days after
            dispatch is the NORMAL case (D-16), not an edge one. */}
        <VendorHelpLine />
      </main>
    )
  }

  const { workOrder } = link
  const context = await vendorJobContext(workOrder)

  // COMM-06's vendor thread, gets-or-creates on first read the same as
  // every other thread in the product - reading it must not require
  // somebody to have sent the first message.
  const thread = await vendorWorkOrderThread({
    id: workOrder.id,
    propertyId: workOrder.propertyId,
    vendorId: link.vendorId,
  })
  const threadMessages = await prisma.message.findMany({
    where: { threadId: thread.id },
    orderBy: { sentAt: 'asc' },
    select: { id: true, body: true, sentAt: true, direction: true },
  })

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
        // THE PROPERTY'S CLOCK, like the messages twenty lines below.
        //
        // These two read UTC while `utcToWallClock` was already in use in the
        // same file - so a vendor who proposed 9am Central read back "14:00".
        // Same defect class as R-036b's entry-window bug: I fixed the admin
        // work order page and missed this one.
        proposedStart: workOrder.proposedStart
          ? utcToWallClock(workOrder.proposedStart, workOrder.property.timezone).replace('T', ' ')
          : null,
        proposedEnd: workOrder.proposedEnd
          ? utcToWallClock(workOrder.proposedEnd, workOrder.property.timezone).replace('T', ' ')
          : null,
        // The CONFIRMED window, which the vendor could not see at all - so
        // somebody whose visit had been booked and legally noticed still read
        // "we'll confirm" and phoned the office to ask.
        scheduledStart: workOrder.scheduledStart
          ? utcToWallClock(workOrder.scheduledStart, workOrder.property.timezone).replace('T', ' ')
          : null,
        scheduledEnd: workOrder.scheduledEnd
          ? utcToWallClock(workOrder.scheduledEnd, workOrder.property.timezone).replace('T', ' ')
          : null,
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
      messages={threadMessages.map((message) => ({
        id: message.id,
        body: message.body,
        sentAt: utcToWallClock(message.sentAt, workOrder.property.timezone).replace(
          'T',
          ' ',
        ),
        fromStaff: message.direction === 'OUTBOUND',
      }))}
      messageAction={sendVendorMessage.bind(null, token)}
    />
  )
}
