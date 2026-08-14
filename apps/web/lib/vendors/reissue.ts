import 'server-only'

import { vendorLinkAccess } from '@rental/core/vendors'
import { prisma } from '@rental/db'
import { hashToken } from '@rental/core/auth'
import { authUrl } from '@/lib/auth/delivery.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { issueVendorLink } from './link.ts'

// An expired link is not a dead end (MAINT-03, D-6, D-16, R-032d).
//
// ==========================================================================
// WHY. The expired-link page told the vendor to "call or text the office and
// we will send a new one" — which is a phone call, a person to answer it, and
// a link retyped by hand. That is exactly the re-keying D-6 exists to
// prevent, and it lands on the two moments a vendor most needs the link to
// work: arriving at a job booked a week ago, and sending the invoice at the
// end of the month.
//
// Extending the TTL alone cannot fix the second one — no reasonable lifetime
// covers "the invoice arrives whenever the vendor gets round to it" — and
// stretching every link to a month would weaken D-16's control set for every
// job in the product to serve a tail case.
// ==========================================================================
//
// SAFE, BECAUSE THE NEW LINK GOES TO THE VENDOR, NOT TO THE CLICKER. Whoever
// opens the dead URL gets told a fresh one has been sent; the link itself is
// texted to the phone number on the vendor record. Somebody holding a stale
// URL therefore gains nothing they did not already have — they cause a text
// to be sent to the legitimate vendor, which is the standard
// expired-link-and-we-emailed-you pattern and is why it is defensible.
//
// It refuses on anything that is not still the vendor's job to do:
// `vendorLinkAccess()` is the SAME check the live link passes, so a
// reassigned, cancelled or closed work order cannot be reopened this way.

export type ReissueOutcome =
  | { reissued: true }
  /// The token was ours and expired, but the job is no longer this vendor's
  /// to act on. Deliberately indistinguishable from `unknown` to the caller's
  /// message, so a stale URL cannot be used to probe job state.
  | { reissued: false; reason: 'not_actionable' | 'unknown' | 'no_contact' | 'failed' }

/**
 * Given a token that failed as EXPIRED, send the vendor a fresh link.
 *
 * Called only on the expired branch. Never on `not_found` — a forged token
 * names nobody, and minting a link for a guessed work order id is the one
 * thing this must not do.
 */
export async function reissueOnExpiry(
  rawToken: string,
  now = new Date(),
): Promise<ReissueOutcome> {
  // The expired row is still there — expiry is a timestamp, not a deletion —
  // so the hash still tells us which job and which vendor this was for.
  const stored = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { purpose: true, subjectId: true, metadata: true, expiresAt: true },
  })
  if (!stored || stored.purpose !== 'VENDOR_WORK_ORDER') return { reissued: false, reason: 'unknown' }
  // Only genuinely expired tokens. A live one has no business here, and a
  // revoked one (`consumedAt`) was killed deliberately — reissuing that would
  // undo a PM cutting off a link they texted to the wrong number.
  if (stored.expiresAt > now) return { reissued: false, reason: 'unknown' }

  const vendorId = (stored.metadata as { vendorId?: string } | null)?.vendorId
  if (!vendorId) return { reissued: false, reason: 'unknown' }

  const workOrder = await prisma.workOrder.findUnique({
    where: { id: stored.subjectId },
    select: {
      id: true,
      status: true,
      scope: true,
      propertyId: true,
      vendorId: true,
      priority: true,
      unit: { select: { name: true } },
      property: { select: { name: true, addressLine1: true } },
      vendor: { select: { id: true, name: true, phone: true, email: true } },
    },
  })
  if (!workOrder) return { reissued: false, reason: 'unknown' }

  // THE SAME GATE THE LIVE LINK PASSES. A reassigned vendor, a cancelled job
  // or a closed one all refuse here exactly as they would have refused with a
  // valid token — expiry must not become a way around the access rules.
  const access = vendorLinkAccess({
    tokenWorkOrderId: workOrder.id,
    workOrderId: workOrder.id,
    tokenVendorId: vendorId,
    currentVendorId: workOrder.vendorId,
    status: workOrder.status,
  })
  if (!access.ok) return { reissued: false, reason: 'not_actionable' }

  const vendor = workOrder.vendor
  if (!vendor?.phone && !vendor?.email) return { reissued: false, reason: 'no_contact' }

  try {
    const { token } = await issueVendorLink(workOrder.id, vendorId, now)

    const outcomes = await notify({
      category: 'work_order_assigned',
      // The SAME template a first dispatch uses. A vendor should not be able
      // to tell a reissue from an ordinary send — it is the same job, the
      // same link, and a second template would drift from this one.
      templateKey: 'workorder.vendor_dispatch',
      recipient: {
        type: 'VENDOR',
        id: vendor.id,
        email: vendor.email,
        phone: vendor.phone,
      },
      context: {
        vendorName: vendor.name,
        scope: workOrder.scope,
        addressLine1: workOrder.property.addressLine1,
        unitName: workOrder.unit.name,
        priority: workOrder.priority,
        link: authUrl(`/vendor/${token}`),
      },
      propertyId: workOrder.propertyId,
      // Keyed on the EXPIRY INSTANT of the token that was used, so one dead
      // link produces one text however many times it is tapped — a vendor
      // refreshing the page must not send themselves five messages — while a
      // genuinely later expiry still gets its own.
      idempotencyKey: `vendor-reissue:${workOrder.id}:${stored.expiresAt.toISOString()}`,
    })

    const deliveryIds = outcomes
      .map((outcome) => outcome.deliveryId)
      .filter((id): id is string => id != null)
    if (deliveryIds.length > 0) {
      await dispatchPendingNotifications(now, 50, { deliveryIds })
    }
    return { reissued: true }
  } catch (error) {
    console.error(`[vendor] could not reissue a link for ${workOrder.id}`, error)
    return { reissued: false, reason: 'failed' }
  }
}
