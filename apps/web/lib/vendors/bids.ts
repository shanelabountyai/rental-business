import 'server-only'

import { checkToken, hashToken, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'

// Bid links (MAINT-04's bid-collection workflow, R-026).
//
// A SEPARATE token purpose from R-025's VENDOR_WORK_ORDER, and the reason is
// an invariant rather than tidiness: a dispatch link is one-per-work-order
// and reissuing revokes the previous one (D-16's control set). Bids need N
// vendors holding live links to the SAME work order simultaneously, which is
// the exact opposite. Sharing the purpose would have meant weakening the
// dispatch invariant for every work order in the product to accommodate a
// workflow that only some of them use.
//
// The multi-use reasoning from D-16 carries over unchanged: a vendor pricing
// a job opens the link, looks at the photos, thinks about it, and comes back
// - burning it on first view would make quoting harder than phoning.

const PURPOSE = 'VENDOR_BID' as const

/**
 * Mints a bid link for ONE vendor on one work order, replacing only that
 * vendor's own earlier link.
 *
 * Revocation is per (work order, vendor), not per work order - re-asking one
 * vendor must not silently kill the other two vendors' live links. The
 * vendor lives in token metadata rather than the subject, so the filtering
 * happens in JS over a small set rather than as a JSON-path query; a work
 * order has a handful of bidders, not thousands.
 */
export async function issueBidLink(
  workOrderId: string,
  vendorId: string,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const minted = mintToken(PURPOSE, now)

  const existing = await prisma.authToken.findMany({
    where: { purpose: PURPOSE, subjectId: workOrderId, consumedAt: null },
    select: { id: true, metadata: true },
  })
  const sameVendor = existing
    .filter((t) => (t.metadata as { vendorId?: string } | null)?.vendorId === vendorId)
    .map((t) => t.id)

  await prisma.$transaction(async (tx) => {
    if (sameVendor.length > 0) {
      await tx.authToken.updateMany({
        where: { id: { in: sameVendor } },
        data: { consumedAt: now },
      })
    }
    await tx.authToken.create({
      data: {
        purpose: PURPOSE,
        tokenHash: minted.tokenHash,
        subjectType: 'WorkOrder',
        subjectId: workOrderId,
        expiresAt: minted.expiresAt,
        metadata: { vendorId },
      },
    })
  })

  return { token: minted.token, expiresAt: minted.expiresAt }
}

export type VerifiedBidLink =
  | {
      ok: true
      bid: NonNullable<Awaited<ReturnType<typeof loadBid>>>
      vendorId: string
    }
  | { ok: false; reason: string }

function loadBid(workOrderId: string, vendorId: string) {
  return prisma.workOrderBid.findUnique({
    where: { workOrderId_vendorId: { workOrderId, vendorId } },
    include: {
      vendor: { select: { id: true, name: true } },
      workOrder: {
        include: {
          property: {
            select: { name: true, addressLine1: true, city: true, state: true, postalCode: true },
          },
          unit: { select: { name: true } },
          ticket: { select: { id: true, description: true } },
        },
      },
    },
  })
}

/**
 * Verifies a bid token and returns the bid row it authorizes.
 *
 * Non-consuming, same as the dispatch link (D-16). Refuses once the work
 * order has moved on - a bid request on a job that has already been assigned
 * to somebody else is not something a vendor should still be able to answer,
 * and leaving it open would collect quotes nobody will read.
 */
export async function verifyBidLink(
  rawToken: string,
  now = new Date(),
): Promise<VerifiedBidLink> {
  const stored = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
  })

  const verdict = checkToken(stored, { purpose: PURPOSE, subjectType: 'WorkOrder' }, now)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  const vendorId = (stored!.metadata as { vendorId?: string } | null)?.vendorId
  if (!vendorId) return { ok: false, reason: 'wrong_subject' }

  const bid = await loadBid(stored!.subjectId, vendorId)
  if (!bid) return { ok: false, reason: 'not_found' }

  // Already assigned, closed or canceled: the bidding is over.
  const open = ['SUBMITTED', 'TRIAGED', 'PENDING_APPROVAL', 'APPROVED']
  if (!open.includes(bid.workOrder.status)) {
    return { ok: false, reason: 'not_actionable' }
  }

  return { ok: true, bid, vendorId }
}
