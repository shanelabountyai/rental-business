import { actualTotalCents, reapprovalCheck } from '@rental/core/approvals'
import { friendlyTimestamp, localParts } from '@rental/core/scheduling'
import { INVOICE_STATUS_LABELS, invoiceLifecycleStatus } from '@rental/core/vendors'
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
import { reissueOnExpiry } from '@/lib/vendors/reissue.ts'
import { vendorJobContext } from '@/lib/vendors/queries.ts'
import { policyFor } from '@/lib/workorders/queries.ts'
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
    // AN EXPIRED LINK SENDS ITSELF A REPLACEMENT (R-032d). The old dead end
    // said "call the office", which is a phone call, somebody to answer it,
    // and an invoice retyped by hand — the re-keying D-6 exists to prevent.
    // The new link is texted to the vendor's own number, never handed to
    // whoever opened this URL, so a stale link is not a way in.
    const reissued =
      link.reason === 'expired' ? await reissueOnExpiry(token) : { reissued: false as const }
    // A plain, unstyled dead end that says which problem this is. NOT a
    // redirect to a sign-in page: there is no account to sign into, and
    // sending a plumber to a login screen is exactly the experience D-6
    // exists to avoid.
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold">
          {reissued.reissued ? 'We\u2019ve sent you a new link' : 'This link isn\u2019t working'}
        </h1>
        <p className="text-base">
          {reissued.reissued
            ? 'That link had expired, so we have just texted you a fresh one for the same job. Open that and carry on \u2014 you do not need to call us.'
            : vendorRejectionMessage(link.reason)}
        </p>
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

  // The vendor's own "where's my check" answer (MAINT-09) - the identical
  // `invoiceLifecycleStatus()`/tolerance read the staff-side work order
  // page uses, so the two can never tell the vendor and the PM two
  // different stories.
  const policy = await policyFor(workOrder.propertyId)
  const invoiceOverTolerance =
    workOrder.invoiceCents != null &&
    reapprovalCheck(workOrder.approvedAmountCents, actualTotalCents(workOrder), policy).outcome ===
      'reapproval_required'
  const invoiceStatusLabel = INVOICE_STATUS_LABELS[
    invoiceLifecycleStatus({
      invoiceCents: workOrder.invoiceCents,
      overTolerance: invoiceOverTolerance,
      invoicePaidAt: workOrder.invoicePaidAt,
    })
  ]

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

  const zone = workOrder.property.timezone
  const friendlyOrNull = (instant: Date | null) =>
    instant ? friendlyTimestamp(instant, zone) : null
  // JUST THE CLOCK for the far end of a window, so the vendor reads
  // "29 Aug 2026, 09:00 CDT to 12:00" rather than the same date twice. The
  // zone abbreviation stays on the opening time and covers both ends.
  //
  // A window crossing midnight would read ambiguously here - "23:00 CDT to
  // 01:00" - and that is unchanged from what this replaced. Entry windows
  // are a few daylight hours by construction; if one ever legitimately spans
  // a day boundary, this is the line that has to grow a date.
  const endClockOrNull = (instant: Date | null) => {
    if (!instant) return null
    const { hour, minute } = localParts(instant, zone)
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }

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
        // THE PROPERTY'S CLOCK, like the messages further down.
        //
        // These two read UTC while a zone-aware read was already in use in
        // the same file - so a vendor who proposed 9am Central read back
        // "14:00". Same defect class as R-036b's entry-window bug: the admin
        // work order page was fixed and this one missed.
        //
        // FORMATTED FOR A PERSON, not for a machine (D-153, R-140). Every
        // one of these was `utcToWallClock(...).replace('T', ' ')`, which
        // renders "2026-08-30 19:00" - a third face of the raw-date class
        // that both R-128's and R-129's sweeps missed, because it is neither
        // a `toISOString().slice(0, 10)` nor a bare `{...On}` interpolation.
        // The vendor is a stranger holding a link, which is the half of the
        // product that rule exists for.
        proposedStart: friendlyOrNull(workOrder.proposedStart),
        proposedEnd: endClockOrNull(workOrder.proposedEnd),
        // The CONFIRMED window, which the vendor could not see at all - so
        // somebody whose visit had been booked and legally noticed still read
        // "we'll confirm" and phoned the office to ask.
        scheduledStart: friendlyOrNull(workOrder.scheduledStart),
        scheduledEnd: endClockOrNull(workOrder.scheduledEnd),
        // THE TENANT'S OWN ANSWERS, finally reaching the person who opens
        // the door (R-032b). R-019 collected both, validated both, and wrote
        // both to the Ticket — where the PM could see them and the vendor
        // could not. The pet warning is the one field on this page with a
        // physical-safety consequence; the entry permission stops the office
        // being asked a question the tenant already answered.
        petWarning: workOrder.ticket?.petWarning ?? false,
        restrictedPartyNote: workOrder.restrictedPartyNote,
        entryPermission: workOrder.ticket?.entryPermission ?? null,
        invoiceUploaded: context.photos.some((p) => p.type === 'INVOICE'),
        completionPhotoUploaded: context.photos.some((p) => p.type === 'COMPLETION_PHOTO'),
        invoiceStatusLabel,
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
        sentAt: friendlyTimestamp(message.sentAt, workOrder.property.timezone),
        fromStaff: message.direction === 'OUTBOUND',
      }))}
      messageAction={sendVendorMessage.bind(null, token)}
    />
  )
}
