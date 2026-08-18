'use server'

import { createHash } from 'node:crypto'
import { headers } from 'next/headers'
import { type DocumentBlock } from '@rental/core/documents'
import { leaseTransition } from '@rental/core/leases'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { auditAsSystem, auditAsTenant } from '@/lib/audit/system.ts'
import { provisionLeaseBilling } from '@/lib/billing/provision.ts'
import { chargeDeposit } from './deposit-charge.ts'
import { esignAdapter } from '@/lib/esign/provider.ts'
import { appendPdfs, renderBlocksPdf } from '@/lib/pdf/render.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import { activateLeaseSideEffects } from './activate.ts'
import { verifySignerLink } from './sign-link.ts'

// A signer's own "sign the lease" action (LEASE-06, DOC-02, R-063).
//
// PUBLIC AND SESSION-LESS, in its own file - R-058's own lesson (a file
// mixing a public action with `audit()`'s Auth.js import fails to load under
// Vitest for every export in the file, so the split is physical, not a
// runtime guard). Uses `auditAsTenant`/`auditAsSystem` instead, neither of
// which touches a session.
//
// "SIGNING" IS OUR OWN DEFINITION, BECAUSE THIS IS SIMULATED (D-7). A typed
// full legal name plus an explicit "this is my electronic signature"
// checkbox is the ESIGN/UETA-shaped minimum (intent to sign, attributable
// identity) - a real embedded provider would host its own ceremony; this
// product hosts its own instead, since there is no real vendor yet.

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

async function clientIp(): Promise<string> {
  const headerList = await headers()
  // Same extraction lib/prospects/actions.ts and lib/auth/actions.ts already
  // duplicate - small enough this codebase repeats it rather than sharing it.
  const forwarded = headerList.get('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() ?? 'unknown'
}

export interface SignFormState {
  error?: string
  notice?: string
}

export async function signLeaseDocument(
  token: string,
  _previous: SignFormState,
  formData: FormData,
): Promise<SignFormState> {
  const link = await verifySignerLink(token)
  if (!link.ok) {
    return {
      error:
        link.reason === 'expired'
          ? 'This signing link has expired. Contact your property manager for a new one.'
          : 'This signing link is not working. Contact your property manager.',
    }
  }
  if (link.envelopeStatus === 'VOIDED') {
    return { error: 'This lease was withdrawn. Contact your property manager for a new link.' }
  }
  if (link.status === 'SIGNED') {
    return { notice: 'You already signed this lease.' }
  }

  const signedName = str(formData, 'signedName')
  const agreed = formData.get('agree') === 'on'
  if (!signedName) {
    return { error: 'Type your full legal name exactly as it should appear on the lease.' }
  }
  if (!agreed) {
    return { error: 'Check the box to confirm this counts as your electronic signature.' }
  }

  const signer = await prisma.leaseSigner.findUniqueOrThrow({
    where: { id: link.signerId },
    include: { envelope: { select: { id: true, status: true, providerId: true, leaseId: true, lease: { select: { propertyId: true } } } } },
  })
  // Re-checked against the live row - the link's own check ran against
  // whatever was true a moment ago.
  if (signer.status === 'SIGNED') return { notice: 'You already signed this lease.' }
  if (signer.envelope.status === 'VOIDED') {
    return { error: 'This lease was withdrawn. Contact your property manager for a new link.' }
  }
  if (!signer.envelope.providerId || !signer.providerSignerId) {
    return { error: 'This envelope has not finished sending yet. Try again in a moment.' }
  }

  const ip = await clientIp()
  const result = await esignAdapter.recordSignature({
    providerId: signer.envelope.providerId,
    signerProviderId: signer.providerSignerId,
    signedName,
    ip,
  })

  await prisma.leaseSigner.update({
    where: { id: signer.id },
    data: { status: 'SIGNED', signedAt: result.signedAt, signedName, signedIp: ip },
  })

  const propertyId = signer.envelope.lease.propertyId
  if (signer.role === 'TENANT' && signer.tenantId) {
    await auditAsTenant(signer.tenantId, {
      action: 'envelope.signer_signed',
      entityType: 'LeaseSigner',
      entityId: signer.id,
      propertyId,
      after: { signedName, order: signer.order },
    }).catch((error: unknown) => console.error(`[esign] audit failed for signer ${signer.id}`, error))
  } else {
    // A guarantor has no account and no session (LEASE-06: "no portal
    // access") - there is no GUARANTOR entry in the closed AuditActor
    // union, so this is recorded as SYSTEM with a ref naming exactly who
    // signed, the same shape a vendor's magic-link action would use if this
    // product had a dedicated auditAsGuarantor.
    await auditAsSystem(`guarantor:${signer.guarantorId}`, {
      action: 'envelope.signer_signed',
      entityType: 'LeaseSigner',
      entityId: signer.id,
      propertyId,
      after: { signedName, order: signer.order },
    }).catch((error: unknown) => console.error(`[esign] audit failed for signer ${signer.id}`, error))
  }

  const remaining = await prisma.leaseSigner.count({
    where: { envelopeId: signer.envelopeId, status: { not: 'SIGNED' } },
  })

  if (remaining === 0) {
    await completeEnvelope(signer.envelopeId)
  } else {
    // Some, but not all, have signed - moves off SENT so the lease page
    // (and the generic activate-button guard in leases/actions.ts) can tell
    // a partially-signed envelope from one nobody has touched yet.
    await prisma.leaseEnvelope.updateMany({
      where: { id: signer.envelopeId, status: 'SENT' },
      data: { status: 'PARTIALLY_SIGNED' },
    })
  }

  revalidatePath(`/leases/${signer.envelope.leaseId}`)
  return {
    notice:
      remaining === 0
        ? 'Signed. Every signer has now completed, and the lease is active.'
        : 'Signed. Thank you.',
  }
}

/**
 * Every signer has signed - build the executed document and finish.
 *
 * ONLY appends a Certificate of Completion to the DRAFT'S OWN BYTES
 * (`appendPdfs`, D-50's own precedent for attaching a second PDF's pages
 * verbatim). The lease body pages are never re-rendered from the template:
 * what a signer actually reviewed is what stays in the executed PDF,
 * unmodified, even if the lease record itself is edited later.
 *
 * ponytail: two signers completing in the same instant could both observe
 * `remaining === 0` and both call this - the `status === 'COMPLETED'` guard
 * below stops the second one from writing a second executed document, but
 * it is a check-then-act race, not a lock. Upgrade to a `SELECT ... FOR
 * UPDATE` on the envelope row if real concurrent last-signers ever show up;
 * for a lease with at most a handful of signers finishing within seconds of
 * each other, the odds are low enough to accept for this build.
 */
async function completeEnvelope(envelopeId: string): Promise<void> {
  const envelope = await prisma.leaseEnvelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: {
      lease: {
        select: {
          id: true,
          propertyId: true,
          unitId: true,
          status: true,
          rentCents: true,
          startsOn: true,
          endsOn: true,
          isMonthToMonth: true,
          leaseTenants: { select: { id: true } },
        },
      },
      draftDocument: true,
      signers: { orderBy: { order: 'asc' } },
    },
  })
  if (envelope.status === 'COMPLETED' || !envelope.draftDocument || !envelope.providerId) return

  // Routed through the same guarded machine every other status write here
  // uses - see activate.ts's own header. A lease that somehow left
  // PENDING_SIGNATURE another way (a direct DB fix, a future path this
  // build did not anticipate) while its envelope was still out refuses the
  // activation rather than forcing it through.
  const toActive = leaseTransition(
    {
      status: envelope.lease.status,
      tenantCount: envelope.lease.leaseTenants.length,
      rentCents: envelope.lease.rentCents,
      startsOn: envelope.lease.startsOn,
      endsOn: envelope.lease.endsOn,
      isMonthToMonth: envelope.lease.isMonthToMonth,
    },
    'ACTIVE',
  )
  if (!toActive.allowed) {
    console.error(
      `[esign] every signer completed on envelope ${envelope.id} but the lease cannot activate: ${toActive.message}`,
    )
    return
  }

  const draftBytes = await storage.get(envelope.draftDocument.storageKey)

  const cert = await esignAdapter.completionCertificate({
    providerId: envelope.providerId,
    documentSha256: envelope.draftDocument.sha256 ?? '',
    signers: envelope.signers.map((s) => ({
      name: s.signedName ?? s.name,
      role: s.role,
      order: s.order,
      signedAt: s.signedAt ?? new Date(),
      signedName: s.signedName ?? s.name,
      signedIp: s.signedIp,
    })),
  })

  const certBlocks: DocumentBlock[] = [
    { kind: 'heading', text: 'Certificate of Completion' },
    { kind: 'meta', text: `Envelope: ${envelope.providerId}` },
    { kind: 'meta', text: `Document hash (SHA-256): ${envelope.draftDocument.sha256 ?? 'unknown'}` },
    { kind: 'meta', text: `Generated: ${cert.generatedAt.toISOString()}` },
    ...cert.certificateText.split('\n').map((line) => ({ kind: 'mono' as const, text: line })),
    {
      kind: 'footer',
      text: 'Generated by a simulated e-signature provider (D-7) - not a real vendor certificate.',
    },
  ]
  const certBytes = Buffer.from(await renderBlocksPdf(certBlocks, { title: 'Certificate of Completion' }))

  const { bytes: executedBytes } = await appendPdfs(draftBytes, [
    { label: 'Certificate of Completion', bytes: certBytes },
  ])
  const executedBuffer = Buffer.from(executedBytes)
  const executedSha256 = createHash('sha256').update(executedBuffer).digest('hex')
  const fileName = `lease-executed-${envelope.leaseId}.pdf`
  const storageKey = generateStorageKey(envelope.lease.propertyId, fileName)
  await storage.put(storageKey, executedBuffer, 'application/pdf')

  await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId: envelope.lease.propertyId,
        leaseId: envelope.leaseId,
        type: 'LEASE',
        fileName,
        contentType: 'application/pdf',
        sizeBytes: executedBuffer.byteLength,
        storageKey,
        sha256: executedSha256,
      },
    })
    await tx.leaseEnvelope.update({
      where: { id: envelope.id },
      data: { status: 'COMPLETED', completedAt: new Date(), executedDocumentId: document.id },
    })

    // Same side effects `changeLeaseStatus` gives a staff-driven activation
    // - see activate.ts's own header for why this is one shared function.
    await activateLeaseSideEffects(tx, {
      id: envelope.lease.id,
      unitId: envelope.lease.unitId,
      propertyId: envelope.lease.propertyId,
    })
    await tx.lease.update({
      where: { id: envelope.lease.id },
      data: { status: 'ACTIVE', activatedAt: new Date() },
    })

    await auditAsSystem(
      'esign.completion',
      {
        action: 'envelope.completed',
        entityType: 'LeaseEnvelope',
        entityId: envelope.id,
        propertyId: envelope.lease.propertyId,
        after: { executedDocumentId: document.id, sha256: executedSha256, signerCount: envelope.signers.length },
      },
      tx,
    )
    await auditAsSystem(
      'esign.completion',
      {
        action: 'lease.status_changed',
        entityType: 'Lease',
        entityId: envelope.lease.id,
        propertyId: envelope.lease.propertyId,
        before: { status: envelope.lease.status },
        after: { status: 'ACTIVE' },
      },
      tx,
    )
  })

  // Billing follows the tenancy (D-11) - AFTER the commit and never allowed
  // to fail the completion itself, the same posture `changeLeaseStatus`
  // already takes for a staff-driven activation.
  await provisionLeaseBilling(envelope.lease.id).catch((error: unknown) => {
    console.error(`[esign] billing provisioning failed for ${envelope.lease.id}`, error)
  })
  await chargeDeposit(envelope.lease.id).catch((error: unknown) => {
    console.error(`[esign] deposit charge failed for ${envelope.lease.id}`, error)
  })
}
