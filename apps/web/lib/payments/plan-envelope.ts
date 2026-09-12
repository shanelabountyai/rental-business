import 'server-only'

import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { esignAdapter } from '@/lib/esign/provider.ts'
import { archiveExecutedDocument } from '@/lib/leases/executed-pdf.ts'

// The system side of a repayment agreement's envelope (PAY-08/LEASE-06,
// R-203): finishing one everybody signed, and withdrawing one the plan has
// outrun.
//
// ==========================================================================
// SPLIT FROM `plan-esign.ts` ON PURPOSE, AND THE SPLIT IS PHYSICAL.
//
// `completePaymentPlanEnvelope` is reached from `esign-actions.ts`, which is
// public and session-less - R-058's lesson is that a file mixing that with
// `audit()`'s Auth.js import fails to load for EVERY export in it. So the
// staff-attributed build-and-send lives next door and this file imports
// `auditAsSystem` only, exactly as `party-change-apply.ts` does.
//
// `voidPlanEnvelope` sits here rather than there for a second reason: the
// nightly break sweep calls it, and that job's own vitest file must not pull
// a session import in through the side door either.
// ==========================================================================

/**
 * Withdraws the envelope for a plan that has been cancelled or broken.
 *
 * A COMPLETED ENVELOPE IS NEVER VOIDED, and that is the whole care in this
 * function. The backlog row asks for "the envelope voided when the plan is
 * cancelled or breaks", and read literally that would destroy the executed
 * agreement at exactly the moment it becomes the most valuable piece of
 * paper on the tenancy - a plan that broke is argued from the terms the
 * tenant signed. What is withdrawn is an envelope still OUT for signature:
 * asking somebody to sign an agreement that no longer exists is the failure
 * this closes.
 *
 * WRITES NO AUDIT ROW OF ITS OWN, deliberately. The void is a consequence,
 * not a decision, and both callers already write the decision's own entry -
 * `lease.payment_plan_cancelled` (staff, with their reason) and
 * `lease.payment_plan_broken` (the sweep). Each folds the returned id into
 * its `after`, so the fact lands on the row somebody actually reads rather
 * than in a second entry that has to be joined to the first, and neither
 * caller has to plumb an audit actor through here.
 *
 * Returns the voided envelope's id, or null when there was nothing to void.
 */
export async function voidPlanEnvelope(planId: string, reason: string): Promise<string | null> {
  const plan = await prisma.paymentPlan.findUnique({
    where: { id: planId },
    select: { envelope: { select: { id: true, status: true, providerId: true } } },
  })
  const envelope = plan?.envelope
  if (!envelope || envelope.status === 'COMPLETED' || envelope.status === 'VOIDED') return null

  if (envelope.providerId) {
    // Never allowed to fail the caller's own work - the same posture
    // `voidEnvelope` takes for a lease. Our row is the record; the provider
    // is somebody else's network.
    await esignAdapter.voidEnvelope({ providerId: envelope.providerId, reason }).catch((error: unknown) => {
      console.error(`[plan-esign] provider void failed for envelope ${envelope.id}`, error)
    })
  }

  // `updateMany` with the status in the predicate, not `update`: two paths
  // can reach a plan's end at once (a staff cancel racing the 06:00 sweep),
  // and the loser must write nothing rather than re-void a row.
  const { count } = await prisma.leaseEnvelope.updateMany({
    where: { id: envelope.id, status: { notIn: ['COMPLETED', 'VOIDED'] } },
    data: { status: 'VOIDED', voidedAt: new Date() },
  })
  return count > 0 ? envelope.id : null
}

/**
 * Every signer has signed the repayment agreement - archive it and finish.
 *
 * WHAT THIS DOES NOT DO IS THE POINT, the same way it is for an amendment.
 * It does not place a hold, lift one, change the plan's status, touch the
 * ledger, or write a Stripe anything. The hold went on when the plan was
 * agreed (D-214) and comes off when the sweep says the plan ended; a
 * signature is evidence of what was agreed, not an event in the plan's own
 * lifecycle. A tenant who never signs is on exactly the same plan as one who
 * does.
 */
export async function completePaymentPlanEnvelope(envelopeId: string): Promise<void> {
  const envelope = await prisma.leaseEnvelope.findUniqueOrThrow({
    where: { id: envelopeId },
    include: {
      lease: { select: { id: true, propertyId: true } },
      draftDocument: true,
      signers: { orderBy: { order: 'asc' } },
      paymentPlan: { select: { id: true } },
    },
  })
  if (envelope.status === 'COMPLETED' || !envelope.draftDocument || !envelope.providerId) return
  // The belt to the caller's braces, matching `completeEnvelope`'s own.
  if (envelope.kind !== 'PAYMENT_PLAN') return
  if (!envelope.paymentPlan) {
    console.error(
      `[plan-esign] envelope ${envelopeId} completed with no payment plan attached - nothing archived`,
    )
    return
  }

  const archived = await archiveExecutedDocument({
    providerId: envelope.providerId,
    propertyId: envelope.lease.propertyId,
    fileName: `repayment-agreement-executed-${envelope.id}.pdf`,
    draftDocument: envelope.draftDocument,
    signers: envelope.signers,
  })

  await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId: envelope.lease.propertyId,
        // The LEASE, so the tenant can find it in their own papers without a
        // second visibility rule - `visibleDocumentWhere` already matches
        // every document on a lease they are on.
        leaseId: envelope.leaseId,
        type: 'PAYMENT_PLAN',
        fileName: archived.fileName,
        contentType: 'application/pdf',
        sizeBytes: archived.sizeBytes,
        storageKey: archived.storageKey,
        sha256: archived.sha256,
      },
    })
    await tx.leaseEnvelope.update({
      where: { id: envelope.id },
      data: { status: 'COMPLETED', completedAt: new Date(), executedDocumentId: document.id },
    })
    await auditAsSystem(
      'esign.completion',
      {
        action: 'envelope.completed',
        entityType: 'LeaseEnvelope',
        entityId: envelope.id,
        propertyId: envelope.lease.propertyId,
        after: {
          kind: 'PAYMENT_PLAN',
          planId: envelope.paymentPlan!.id,
          executedDocumentId: document.id,
          sha256: archived.sha256,
          signerCount: envelope.signers.length,
        },
      },
      tx,
    )
  })
}
