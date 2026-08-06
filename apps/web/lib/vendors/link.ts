import 'server-only'

import { checkToken, hashToken, mintToken } from '@rental/core/auth'
import { vendorLinkAccess } from '@rental/core/vendors'
import { prisma } from '@rental/db'

// The vendor magic link (D-6, D-16, MAINT-03, R-025).
//
// ================================ SECURITY ================================
// This file is the ENTIRE authorization story for a vendor. There is no
// account, no session, no RBAC row (D-6) - the token in the URL is the
// credential, and everything a vendor can reach in this product goes through
// `verifyVendorLink()` below.
//
// THE ONE THING THAT MAKES THIS DIFFERENT FROM EVERY OTHER TOKEN IN THE
// PRODUCT: it is deliberately NOT single-use, and `redeemToken()` from
// lib/auth/store.ts is deliberately NOT used here. Calling it would burn the
// token on the vendor's first look, so the plumber who opened the text at
// 7am to accept could not reopen it at 4pm to upload the invoice - which is
// every real job, not an edge case. D-16 records that decision, what was
// rejected (a work-order-scoped session cookie: dies on a cleared cookie, a
// second device, or simply re-clicking the original SMS), and the control
// set that replaces single-use. Those controls are, and must remain:
//
//   1. SCOPED. The token names exactly one work order and grants nothing
//      else anywhere in the product. `vendorLinkAccess()` re-checks the
//      binding on every single request (packages/core/vendors/access.ts).
//   2. EXPIRING. TOKEN_TTL_MINUTES.VENDOR_WORK_ORDER, three days.
//   3. REVOCABLE. `issueVendorLink()` burns every prior token for the same
//      work order, so resending is how a leaked link is killed.
//   4. AUDITED. Every privileged action through it names the vendor as
//      actor, and each access-code reveal is logged individually (PROP-03).
//   5. STATUS-BOUND. The link dies when the job does - a closed or
//      reassigned work order refuses a token that has not expired yet.
//
// If a later change makes any of those five stop being true, D-16's
// reasoning no longer holds and the multi-use decision has to be re-argued.
// ==========================================================================

const PURPOSE = 'VENDOR_WORK_ORDER' as const

/**
 * Mints a link for a work order, revoking every earlier one for it.
 *
 * Revoke-then-issue, in that order and in one transaction: a work order has
 * at most one live vendor link at a time, so "resend the link" is also "kill
 * the link I just texted to the wrong number." Without this, every resend
 * would widen the set of live credentials instead of replacing it.
 *
 * The raw token is returned and never stored - only its SHA-256 goes to the
 * database (packages/core/auth/tokens.ts). A dump of AuthToken yields
 * nothing anyone can click.
 */
export async function issueVendorLink(
  workOrderId: string,
  vendorId: string,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const minted = mintToken(PURPOSE, now)

  await prisma.$transaction(async (tx) => {
    await tx.authToken.updateMany({
      where: { purpose: PURPOSE, subjectId: workOrderId, consumedAt: null },
      data: { consumedAt: now },
    })
    await tx.authToken.create({
      data: {
        purpose: PURPOSE,
        tokenHash: minted.tokenHash,
        subjectType: 'WorkOrder',
        subjectId: workOrderId,
        expiresAt: minted.expiresAt,
        // The vendor this link was minted FOR. `vendorLinkAccess()` compares
        // it against whoever the work order currently names, which is what
        // stops a reassigned vendor's un-expired link from still opening a
        // gate code.
        metadata: { vendorId },
      },
    })
  })

  return { token: minted.token, expiresAt: minted.expiresAt }
}

/// Kills every live link for a work order without minting a replacement -
/// what reassignment and cancellation call. Named separately from
/// issueVendorLink so a caller cannot revoke by accident while meaning to
/// resend, or vice versa.
export async function revokeVendorLinks(
  workOrderId: string,
  now = new Date(),
): Promise<number> {
  const { count } = await prisma.authToken.updateMany({
    where: { purpose: PURPOSE, subjectId: workOrderId, consumedAt: null },
    data: { consumedAt: now },
  })
  return count
}

export type VendorLinkRejection =
  | 'not_found'
  | 'expired'
  | 'already_used'
  | 'wrong_purpose'
  | 'wrong_subject'
  | 'wrong_work_order'
  | 'reassigned'
  | 'not_actionable'

export type VerifiedVendorLink = {
  ok: true
  workOrder: NonNullable<Awaited<ReturnType<typeof loadWorkOrder>>>
  vendorId: string
  expiresAt: Date
}

function loadWorkOrder(id: string) {
  return prisma.workOrder.findUnique({
    where: { id },
    include: {
      property: { select: { id: true, name: true, addressLine1: true, city: true, state: true, postalCode: true } },
      unit: { select: { id: true, name: true } },
      vendor: { select: { id: true, name: true } },
      ticket: { select: { id: true, category: true, description: true, tenant: { select: { firstName: true, phone: true } } } },
    },
  })
}

/**
 * Verifies a raw token from a URL and returns the work order it authorizes.
 *
 * NON-CONSUMING by design (see this file's header and D-16). `checkToken()`
 * is reused unchanged from packages/core/auth - its `already_used` branch
 * still fires, and still matters, because `revokeVendorLinks()` marks
 * `consumedAt` to kill a link. What differs from every other purpose is only
 * that ordinary USE never sets that column.
 *
 * Returns a discriminated rejection rather than throwing: the caller renders
 * a page that says what is wrong, since a vendor with a dead link needs to
 * know whether to scroll up for a newer text or phone the office.
 */
export async function verifyVendorLink(
  rawToken: string,
  now = new Date(),
): Promise<VerifiedVendorLink | { ok: false; reason: VendorLinkRejection }> {
  const stored = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
  })

  const verdict = checkToken(stored, { purpose: PURPOSE, subjectType: 'WorkOrder' }, now)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  const workOrder = await loadWorkOrder(stored!.subjectId)
  if (!workOrder) return { ok: false, reason: 'not_found' }

  const tokenVendorId = (stored!.metadata as { vendorId?: string } | null)?.vendorId
  if (!tokenVendorId) return { ok: false, reason: 'wrong_subject' }

  const access = vendorLinkAccess({
    tokenWorkOrderId: stored!.subjectId,
    workOrderId: workOrder.id,
    tokenVendorId,
    currentVendorId: workOrder.vendorId,
    status: workOrder.status,
  })
  if (!access.ok) return { ok: false, reason: access.reason }

  return { ok: true, workOrder, vendorId: tokenVendorId, expiresAt: stored!.expiresAt }
}
