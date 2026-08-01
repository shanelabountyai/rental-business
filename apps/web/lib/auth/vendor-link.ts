import 'server-only'

import { prisma } from '@rental/db'
import { authUrl, deliverAuthLink } from './delivery.ts'
import { issueToken, redeemToken } from './store.ts'

// D-6: a vendor gets a signed, expiring, single-use work-order link and never
// an account. "A plumber with five landlord clients will not learn a sixth
// portal, and a maintenance module vendors won't touch has no data in it."
//
// R-003 owns the primitive; R-025 owns the dispatch flow and the page the link
// opens. R-025 should extend the metadata below rather than inventing a second
// token table - that is the D-9 lesson applied to tokens.
//
// A vendor link is NOT a session. Redeeming it does not sign anyone in; it
// authorizes one scoped view of one work order. That distinction is what keeps
// a forwarded SMS from becoming an account.

export interface VendorLinkScope {
  workOrderId: string
  vendorId: string
  /// What the link may do. R-025 will grow this - accept, propose a time,
  /// upload photos, upload an invoice, reveal the access code.
  abilities: readonly string[]
}

export async function issueVendorLink(scope: VendorLinkScope): Promise<{
  url: string
  expiresAt: Date
}> {
  const issued = await issueToken(
    'VENDOR_WORK_ORDER',
    { type: 'WorkOrder', id: scope.workOrderId },
    {
      metadata: {
        vendorId: scope.vendorId,
        abilities: [...scope.abilities],
      },
    },
  )

  return {
    url: authUrl(`/vendor/${issued.token}`),
    expiresAt: issued.expiresAt,
  }
}

export async function sendVendorLink(
  scope: VendorLinkScope,
  to: string,
): Promise<void> {
  const link = await issueVendorLink(scope)
  await deliverAuthLink({
    kind: 'vendor_work_order',
    to,
    url: link.url,
    expiresAt: link.expiresAt,
  })
}

export type VendorLinkResult =
  | { ok: true; scope: VendorLinkScope }
  | { ok: false; reason: string }

/**
 * Burns the link and returns what it authorizes.
 *
 * Single-use is a real constraint for a vendor link, not a formality: a
 * dispatch SMS gets forwarded, screenshotted and pasted into group chats.
 * R-025 will need to reissue rather than reuse, which is the correct shape -
 * every reissue is a new row and therefore a new line in the evidence trail.
 */
export async function redeemVendorLink(
  token: string,
): Promise<VendorLinkResult> {
  const redeemed = await redeemToken(token, {
    purpose: 'VENDOR_WORK_ORDER',
    subjectType: 'WorkOrder',
  })
  if (!redeemed.ok) return { ok: false, reason: redeemed.reason }

  const metadata = (redeemed.metadata ?? {}) as {
    vendorId?: string
    abilities?: string[]
  }
  if (!metadata.vendorId) return { ok: false, reason: 'malformed' }

  // The work order and vendor must still be real and active. A link issued
  // before a vendor was deactivated must not still open.
  const [workOrder, vendor] = await Promise.all([
    prisma.workOrder.findUnique({ where: { id: redeemed.subjectId } }),
    prisma.vendor.findUnique({ where: { id: metadata.vendorId } }),
  ])
  if (!workOrder) return { ok: false, reason: 'work_order_missing' }
  if (!vendor?.active) return { ok: false, reason: 'vendor_inactive' }

  return {
    ok: true,
    scope: {
      workOrderId: workOrder.id,
      vendorId: vendor.id,
      abilities: metadata.abilities ?? [],
    },
  }
}
