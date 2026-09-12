import 'server-only'

import { createHash } from 'node:crypto'
import { orderedSigners } from '@rental/core/leases'
import { formatCents } from '@rental/core/money'
import { paymentPlanDocumentBlocks } from '@rental/core/payments'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { issueToken } from '@/lib/auth/store.ts'
import { esignAdapter } from '@/lib/esign/provider.ts'
import { notify } from '@/lib/notifications/send.ts'
import { renderBlocksPdf } from '@/lib/pdf/render.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Generating a repayment agreement and sending it for signature
// (PAY-08/LEASE-06, R-203, D-214).
//
// ==========================================================================
// A SEPARATE PRESS FROM AGREEING THE PLAN, AND THAT IS THE ITEM'S OWN RULE.
//
// The signature is "the operator's choice per plan, never a condition of the
// hold" (D-214). A plan agreed on the phone at 4pm pauses the chase and the
// late-fee meter at 4pm; whether anybody is ever asked to sign paper for it
// is a decision taken afterwards, on the same screen, or not at all.
//
// Folding this into `agreePaymentPlan` would have been one less button and
// would have quietly made the pause wait on a tenant's inbox - which is the
// exact harm R-175 exists to prevent, wearing the opposite sign.
// ==========================================================================
//
// TENANTS SIGN; GUARANTORS DO NOT. R-199 SENDS the schedule to every active
// guarantor, because they are somebody the chase would otherwise write to
// and this switches that chase off. Asking them to SIGN it is a different
// act with a legal meaning nobody asked for: a guarantor's signature on a
// repayment agreement is an argument that they reaffirmed the underlying
// debt on new terms, and this product must not manufacture that by default.
// If an operator ever needs it, `orderedSigners` already takes guarantors
// and this is a one-line change - with counsel, deliberately.

export interface PlanEsignResult {
  error?: string
  notice?: string
}

/**
 * Generates the agreement, archives the unsigned draft, builds the signer
 * list and sends each tenant their own link.
 *
 * RE-SENDABLE ONLY AFTER A WITHDRAWAL, the same rule `generateAndSendLease`
 * states: an envelope already out for signature refuses rather than
 * generating a second document for the same plan. A VOIDED one does not
 * refuse - the plan then points at the new envelope, and the withdrawn one
 * stays on the lease as evidence (see `LeaseEnvelope.leaseId`'s own comment
 * for why that column is not unique).
 */
export async function sendPlanForSignature(planId: string): Promise<PlanEsignResult> {
  // Inlined rather than hoisted to a `const ... as const`: Prisma's argument
  // types reject a readonly `orderBy` tuple, and this one needs two keys to
  // make the signer order deterministic.
  const plan = await prisma.paymentPlan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      status: true,
      arrearsCents: true,
      startedOn: true,
      note: true,
      leaseId: true,
      propertyId: true,
      envelope: { select: { id: true, status: true } },
      instalments: {
        select: { sequence: true, dueOn: true, amountCents: true },
        orderBy: { sequence: 'asc' },
      },
      lease: {
        select: {
          id: true,
          property: {
            select: {
              id: true,
              legalEntityId: true,
              name: true,
              addressLine1: true,
              timezone: true,
              legalEntity: { select: { name: true } },
            },
          },
          unit: { select: { name: true } },
          leaseTenants: {
            select: {
              tenant: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  phone: true,
                  active: true,
                },
              },
            },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          },
        },
      },
    },
  })
  if (!plan) return { error: 'That plan no longer exists.' }

  // `hold.manage`, the same authority agreeing the plan runs on. Asking for
  // a signature on an agreement somebody already had the authority to make
  // is a strictly smaller act than making it.
  const actor = await requirePermission('hold.manage', propertyResource(plan.lease.property))

  if (plan.status !== 'ACTIVE') {
    return { error: 'Only a plan that is still in force can be sent for signature.' }
  }
  if (plan.envelope && plan.envelope.status !== 'VOIDED') {
    return {
      error:
        plan.envelope.status === 'COMPLETED'
          ? 'This plan has already been signed.'
          : 'This plan is already out for signature. Ending it and agreeing a new one is what replaces the agreement — re-sending the same paper is not offered.',
    }
  }

  const tenants = plan.lease.leaseTenants.map((lt) => lt.tenant).filter((tenant) => tenant.active)
  if (tenants.length === 0) {
    return { error: 'Nobody active is on this tenancy to sign the plan.' }
  }

  const name = (t: { firstName: string; lastName: string }) => `${t.firstName} ${t.lastName}`
  const signers = orderedSigners({
    primaryTenant: { id: tenants[0]!.id, name: name(tenants[0]!) },
    otherTenants: tenants.slice(1).map((t) => ({ id: t.id, name: name(t) })),
    guarantors: [],
  })

  const generatedOn = businessDate(new Date(), plan.lease.property.timezone)
  const instalments = plan.instalments.map((row) => ({
    sequence: row.sequence,
    // `@db.Date`. Read with `utcToBusinessDate` - putting a calendar day
    // through a timezone is the R-042 bug in a new place.
    dueOn: utcToBusinessDate(row.dueOn),
    amountCents: row.amountCents,
  }))

  const blocks = paymentPlanDocumentBlocks({
    propertyName: plan.lease.property.name,
    propertyAddress: plan.lease.property.addressLine1,
    unitName: plan.lease.unit.name,
    entityName: plan.lease.property.legalEntity.name,
    tenantNames: tenants.map(name),
    arrearsCents: plan.arrearsCents,
    agreedOn: utcToBusinessDate(plan.startedOn),
    generatedOn,
    note: plan.note,
    instalments,
    signers: signers.map((s) => ({
      order: s.order,
      role: s.role,
      name: s.name,
      signedAt: null,
      signedName: null,
    })),
  })

  const bytes = await renderBlocksPdf(blocks, {
    title: `Repayment agreement — ${plan.lease.property.name} ${plan.lease.unit.name}`,
  })
  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `repayment-agreement-draft-${plan.id}.pdf`
  const storageKey = generateStorageKey(plan.propertyId, fileName)
  // Stored before the row - orphaned-object-over-orphaned-row, the same
  // order every other archiver here uses.
  await storage.put(storageKey, buffer, 'application/pdf')

  const contacts = new Map(tenants.map((t) => [t.id, { email: t.email, phone: t.phone }]))

  const envelopeId = await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId: plan.propertyId,
        leaseId: plan.leaseId,
        type: 'PAYMENT_PLAN',
        fileName,
        contentType: 'application/pdf',
        sizeBytes: buffer.byteLength,
        storageKey,
        sha256,
        uploadedByStaffId: actor.id,
      },
    })
    const envelope = await tx.leaseEnvelope.create({
      data: {
        leaseId: plan.leaseId,
        kind: 'PAYMENT_PLAN',
        // No template, for the same reason an amendment has none: the text
        // is generated from the facts of the plan, and there is nothing in
        // it for an author to write that is not already a field.
        templateId: null,
        status: 'DRAFT',
        addendumKeys: [],
        draftDocumentId: document.id,
      },
    })
    await tx.paymentPlan.update({ where: { id: plan.id }, data: { envelopeId: envelope.id } })
    for (const s of signers) {
      const contact = contacts.get(s.tenantId ?? '')
      await tx.leaseSigner.create({
        data: {
          envelopeId: envelope.id,
          order: s.order,
          role: s.role,
          name: s.name,
          email: contact?.email ?? null,
          phone: contact?.phone ?? null,
          tenantId: s.tenantId ?? null,
        },
      })
    }
    await audit(
      {
        action: 'document.generated',
        entityType: 'Document',
        entityId: document.id,
        propertyId: plan.propertyId,
        after: {
          kind: 'PAYMENT_PLAN',
          planId: plan.id,
          leaseId: plan.leaseId,
          sha256,
          sizeBytes: buffer.byteLength,
        },
      },
      tx,
    )
    return envelope.id
  })

  const signerRows = await prisma.leaseSigner.findMany({
    where: { envelopeId },
    orderBy: { order: 'asc' },
  })

  let created: { providerId: string; signerProviderIds: Record<string, string> }
  try {
    created = await esignAdapter.createEnvelope({
      leaseId: plan.leaseId,
      documentSha256: sha256,
      signers: signerRows.map((s) => ({
        localId: s.id,
        order: s.order,
        role: s.role,
        name: s.name,
        email: s.email,
      })),
    })
  } catch (error) {
    console.error(`[plan-esign] createEnvelope failed for plan ${plan.id}`, error)
    // The DRAFT envelope and its document stand, and the plan already points
    // at them. THERE IS NO RETRY FROM HERE, deliberately: a second press
    // would refuse (the envelope is not VOIDED), and the recovery is to end
    // the plan and agree it again, which voids this envelope on the way out.
    // A retry that generated a second agreement for the same plan would be
    // two pieces of paper saying the same thing, one of which nobody signed.
    return {
      error:
        'Could not reach the e-signature provider. The agreement was saved — withdraw it and try again.',
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.leaseEnvelope.update({
      where: { id: envelopeId },
      data: { providerId: created.providerId, status: 'SENT', sentAt: new Date() },
    })
    for (const s of signerRows) {
      await tx.leaseSigner.update({
        where: { id: s.id },
        data: { providerSignerId: created.signerProviderIds[s.id], status: 'SENT' },
      })
    }
    await audit(
      {
        action: 'envelope.sent',
        entityType: 'LeaseEnvelope',
        entityId: envelopeId,
        propertyId: plan.propertyId,
        after: {
          kind: 'PAYMENT_PLAN',
          planId: plan.id,
          signerCount: signerRows.length,
          provider: esignAdapter.name,
        },
      },
      tx,
    )
  })

  // One link per signer, outside the transaction - notify() has its own
  // resilience (R-016's outbox), so a failed send here does not roll back the
  // envelope the way a failed provider call above does.
  const reached: string[] = []
  const unreached: string[] = []
  for (const s of signerRows) {
    if (!s.email && !s.phone) {
      unreached.push(s.name)
      continue
    }
    const issued = await issueToken('LEASE_SIGN', { type: 'LeaseSigner', id: s.id })
    await notify({
      category: 'lease_signature',
      templateKey: 'payment_plan.sign_invite',
      recipient: { type: 'TENANT', id: s.tenantId ?? s.id, email: s.email, phone: s.phone },
      context: {
        name: s.name,
        addressLine1: plan.lease.property.addressLine1,
        total: formatCents(plan.arrearsCents),
        instalmentCount: instalments.length,
        firstDueOn: instalments[0]!.dueOn,
        url: authUrl(`/sign/${issued.token}`),
      },
      propertyId: plan.propertyId,
      // The envelope and the person, not the plan: a withdrawn-and-resent
      // agreement is a new envelope and must produce a new invitation.
      idempotencyKey: `payment-plan-sign-invite:${s.id}`,
    })
    reached.push(s.name)
  }

  return {
    notice: [
      reached.length > 0
        ? `Sent for signature to ${reached.join(', ')}.`
        : 'The agreement was generated, but nobody could be sent a link.',
      // Said out loud rather than left to be discovered. Unlike the schedule
      // R-199 sends, there is nothing to hand over here: a signing link is
      // per-person and is only ever minted onto a channel, so a signer with
      // no email and no phone cannot sign at all.
      unreached.length > 0
        ? ` ${unreached.join(', ')} has no email or phone we may use, so there is no way to send them a link to sign.`
        : '',
    ].join(''),
  }
}
