import 'server-only'

import { checkToken, hashToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { esignAdapter } from '@/lib/esign/provider.ts'

// Verifying a signer's own LEASE_SIGN link (LEASE-06, R-063).
//
// Plain module, NOT a 'use server' action file - `/sign/[token]/page.tsx`
// (a Server Component) calls `verifySignerLink`/`markSignerViewed` directly
// during render, the way `verifyPayLink` is read from the pay-link page.
// The actual SIGN submission is a real form action and lives in
// `esign-actions.ts` instead, matching R-058's own lesson: a public,
// session-less write belongs in its own file so `audit()`'s Auth.js import
// never has a reason to load alongside it - not strictly required here
// (this only calls `auditAsTenant`/`auditAsSystem`, which import no
// session), but the same split keeps every public lease-signing surface in
// one place.
//
// NON-CONSUMING, like every other multi-use link in this product - the page
// must render before the tenant signs, so burning the token on the GET
// would leave the POST unauthenticated.

const PURPOSE = 'LEASE_SIGN' as const

export type SignerLinkResult =
  | {
      ok: true
      signerId: string
      envelopeId: string
      leaseId: string
      name: string
      role: 'TENANT' | 'GUARANTOR'
      /// R-090: what the signer is being asked to put their name to. The
      /// page and the sign action both word themselves from this - telling
      /// a departing roommate "your lease is ready to sign" would be
      /// actively wrong about what they are agreeing to.
      kind: 'LEASE' | 'AMENDMENT'
      status: 'PENDING' | 'SENT' | 'VIEWED' | 'SIGNED' | 'DECLINED'
      envelopeStatus: 'DRAFT' | 'SENT' | 'PARTIALLY_SIGNED' | 'COMPLETED' | 'VOIDED'
      propertyName: string
      propertyAddress: string
      unitName: string
      /// The document to show: the executed PDF once every signer has
      /// completed, the unsigned draft until then.
      documentId: string | null
    }
  | { ok: false; reason: 'invalid' | 'expired' }

export async function verifySignerLink(token: string, now = new Date()): Promise<SignerLinkResult> {
  const stored = await prisma.authToken.findFirst({
    where: { purpose: PURPOSE, tokenHash: hashToken(token) },
  })
  const check = checkToken(stored ?? null, { purpose: PURPOSE, subjectType: 'LeaseSigner' }, now)
  if (!check.ok) {
    return { ok: false, reason: check.reason === 'expired' ? 'expired' : 'invalid' }
  }

  const signer = await prisma.leaseSigner.findUnique({
    where: { id: stored!.subjectId },
    include: {
      envelope: {
        include: {
          lease: {
            include: {
              property: { select: { name: true, addressLine1: true } },
              unit: { select: { name: true } },
            },
          },
          draftDocument: { select: { id: true } },
          executedDocument: { select: { id: true } },
        },
      },
    },
  })
  if (!signer) return { ok: false, reason: 'invalid' }

  return {
    ok: true,
    signerId: signer.id,
    envelopeId: signer.envelopeId,
    leaseId: signer.envelope.leaseId,
    name: signer.name,
    role: signer.role,
    kind: signer.envelope.kind,
    status: signer.status,
    envelopeStatus: signer.envelope.status,
    propertyName: signer.envelope.lease.property.name,
    propertyAddress: signer.envelope.lease.property.addressLine1,
    unitName: signer.envelope.lease.unit.name,
    documentId: signer.envelope.executedDocument?.id ?? signer.envelope.draftDocument?.id ?? null,
  }
}

/**
 * Records that a signer opened the document - once. Idempotent: called on
 * every page render, but only writes (and calls the provider) the first
 * time, matching `recordAudit`'s own "the fact, not the click" posture.
 * Re-fetches the row itself rather than taking it as a parameter, so the
 * page can call this right after `verifySignerLink` with just the id.
 */
export async function markSignerViewed(signerId: string): Promise<void> {
  const signer = await prisma.leaseSigner.findUnique({
    where: { id: signerId },
    select: { id: true, status: true, providerSignerId: true, envelope: { select: { providerId: true } } },
  })
  if (!signer || (signer.status !== 'PENDING' && signer.status !== 'SENT')) return

  if (signer.envelope.providerId && signer.providerSignerId) {
    await esignAdapter
      .recordView({ providerId: signer.envelope.providerId, signerProviderId: signer.providerSignerId })
      .catch((error: unknown) => {
        console.error(`[esign] recordView failed for signer ${signerId}`, error)
      })
  }
  await prisma.leaseSigner
    .updateMany({
      where: { id: signerId, status: { in: ['PENDING', 'SENT'] } },
      data: { status: 'VIEWED', viewedAt: new Date() },
    })
    .catch((error: unknown) => {
      console.error(`[esign] could not record view for signer ${signerId}`, error)
    })
}
