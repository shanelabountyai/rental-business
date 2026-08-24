import 'server-only'

import { createHash } from 'node:crypto'
import { amendmentDocumentBlocks, assessPartyChange, orderedSigners } from '@rental/core/leases'
import { formatCents } from '@rental/core/money'
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

// Building a change of who is on a live lease (RISK-10, R-090; R-091b).
//
// ==========================================================================
// ONE BUILDER, TWO ENTRY POINTS, AND NO "SKIP SIGNATURES" OPTION ANYWHERE.
//
// R-091b needs a party change that goes ahead without one person's signature.
// The obvious way to get one is a checkbox on the ordinary panel, and it is
// the wrong way twice over: it would put "do not ask them to sign" in front
// of every operator doing an ordinary roommate swap, and it would make the
// dangerous variant reachable by the permission that covers the safe one.
//
// So the LOGIC is shared and the ENTRY POINTS are not. `startPartyChange`
// (lease page, `lease.execute`) passes `unsigned: null` and has no way to
// pass anything else. `startConfidentialBifurcation` (behind
// `confidential.manage`, which is privileged) is the only caller that can,
// and it fixes both the basis and the reason itself rather than taking either
// from a form.
// ==========================================================================

export interface PartyChangeFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
  warnings?: string[]
}

/// Who is being removed without being asked to sign, and on what basis.
/// `basis` is deliberately not a parameter with a wide type: there is one
/// value, it says a statute excused the signature, and it never says which
/// statute (D-107).
export interface UnsignedRemoval {
  tenantIds: readonly string[]
}

export type LeaseForPartyChange = Awaited<ReturnType<typeof loadLeaseForPartyChange>>['lease']

/**
 * The lease, and the `lease.execute` check both entry points make.
 *
 * The confidential path checks its own permission FIRST and then this one on
 * top: taking somebody off a lease is a lease-execution act whatever the
 * reason for it, and an actor who could not do it on the lease page must not
 * be able to do it from a case file either.
 */
export async function loadLeaseForPartyChange(leaseId: string) {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    include: {
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
      unit: { select: { id: true, name: true } },
      leaseTenants: {
        include: {
          tenant: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          },
        },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      },
      guarantors: true,
    },
  })
  const actor = await requirePermission('lease.execute', propertyResource(lease.property))
  return { lease, actor }
}

export interface BuildPartyChangeInput {
  lease: LeaseForPartyChange
  actorId: string
  /// Tenant ids, not LeaseTenant ids - the form speaks in LeaseTenant rows
  /// and translates before it gets here, because the confidential path only
  /// ever has a Tenant id to hand.
  outgoingTenantIds: readonly string[]
  incomingApplicantIds: readonly string[]
  effectiveOn: string
  reason: string
  acknowledgedWarnings: boolean
  unsigned: UnsignedRemoval | null
}

/**
 * Generates the amendment, writes the change, and sends it for signature.
 *
 * ONE ACTION, NOT A DRAFT-THEN-SEND PAIR. There is nothing to review between
 * the two: the document is generated from the form that was just filled in,
 * and a half-built change nobody has been asked to sign is a decision
 * somebody is still making, not a record worth a row.
 */
export async function buildPartyChange(
  input: BuildPartyChangeInput,
): Promise<PartyChangeFormState & { changeId?: string }> {
  const { lease } = input
  const unsignedIds = new Set(input.unsigned?.tenantIds ?? [])

  const live = await prisma.leasePartyChange.findFirst({
    where: { leaseId: lease.id, status: 'PENDING_SIGNATURE' },
    select: { id: true },
  })
  if (live) {
    return {
      error:
        'A change of occupants is already out for signature on this lease. Withdraw it before starting another.',
    }
  }

  const outgoing = lease.leaseTenants
    .filter((lt) => input.outgoingTenantIds.includes(lt.tenant.id))
    .map((lt) => ({ tenantId: lt.tenant.id, name: `${lt.tenant.firstName} ${lt.tenant.lastName}` }))
  if (outgoing.length !== input.outgoingTenantIds.length) {
    return { error: 'One of the people named as leaving is not on this lease.' }
  }

  // The applicant IS the screening record (R-088's own precedent for
  // "this person was held to the same criteria as everybody else"). Loaded
  // with the report so `assessPartyChange` gets the decision rather than a
  // boolean somebody derived here.
  const applicants =
    input.incomingApplicantIds.length > 0
      ? await prisma.applicant.findMany({
          where: { id: { in: [...input.incomingApplicantIds] } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            monthlyIncomeCents: true,
            screeningReport: { select: { decision: true } },
          },
        })
      : []
  if (applicants.length !== input.incomingApplicantIds.length) {
    return { error: 'One of the applicants named could not be found.' }
  }

  const criteria = await prisma.screeningCriteria.findFirst({
    orderBy: { version: 'desc' },
    select: { incomeToRentMultiplierX100: true },
  })

  // Placeholder tenant ids so the assessment can reason about the resulting
  // household before any row is written - swapped for the real ones below.
  const incoming = applicants.map((a) => ({
    tenantId: `applicant:${a.id}`,
    name: `${a.firstName} ${a.lastName}`,
    applicantId: a.id,
    screeningDecision: (a.screeningReport?.decision ?? null) as
      | 'APPROVED'
      | 'DECLINED'
      | 'CONDITIONAL'
      | null,
    monthlyIncomeCents: a.monthlyIncomeCents,
  }))

  // The SAME assessment for both entry points, and the confidential one is
  // not exempted from any of it. In particular "this would leave nobody on
  // the tenancy" still refuses: removing the only occupant is the end of a
  // tenancy, with its own deposit disposition and its own notice periods, and
  // a statutory basis for not asking somebody to sign is not a basis for
  // ending a lease through the roommate-change door.
  const assessment = assessPartyChange(
    {
      leaseStatus: lease.status,
      currentTenantIds: lease.leaseTenants.map((lt) => lt.tenant.id),
      outgoing,
      incoming,
      effectiveOn: input.effectiveOn,
      leaseStartsOn: utcToBusinessDate(lease.startsOn),
      leaseEndsOn: lease.endsOn ? utcToBusinessDate(lease.endsOn) : null,
      reason: input.reason,
    },
    criteria ? { ...criteria, rentCents: lease.rentCents } : null,
  )

  if (assessment.violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(assessment.violations.map((v) => [v.field, v.message])),
    }
  }
  // Shown once, then requires a positive acknowledgement - the same posture
  // every other advisory warning in this product takes. It never blocks.
  if (assessment.warnings.length > 0 && !input.acknowledgedWarnings) {
    return {
      error: 'Read the warning below, then confirm to send.',
      warnings: assessment.warnings.map((w) => w.message),
    }
  }

  // No `staff.name` merge field: an amendment names the PARTIES to the
  // lease, and whoever in the office typed it in is not one of them. The
  // audit entry records who did it, which is where that belongs.
  const generatedOn = businessDate(new Date(), lease.property.timezone)

  // The incoming party's Tenant row is created HERE, not on completion: they
  // have to be an addressable party to be sent a signing link at all. If the
  // change is later withdrawn the row is simply a person in the portfolio
  // who is on no lease, which is what they are.
  //
  // Always a new row, never matched against an existing Tenant by name or
  // email. Guessing that two people with the same name are one person is a
  // worse failure than a duplicate: it would attach a stranger's tenancy
  // history, portal access and ledger to somebody else.
  const incomingTenants = await prisma.$transaction(
    applicants.map((a) =>
      prisma.tenant.create({
        data: { firstName: a.firstName, lastName: a.lastName, email: a.email, phone: a.phone },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      }),
    ),
  )
  const tenantByApplicant = new Map(applicants.map((a, i) => [a.id, incomingTenants[i]!]))

  const outgoingIds = new Set(outgoing.map((p) => p.tenantId))
  const staying = lease.leaseTenants.filter((lt) => !outgoingIds.has(lt.tenant.id))
  const leaving = lease.leaseTenants.filter((lt) => outgoingIds.has(lt.tenant.id))

  const name = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`

  // Signer order: whoever is staying (primary first), then whoever is
  // joining, then whoever is leaving, then guarantors. Not alphabetical and
  // not arbitrary - it reads down the page as the household before, the
  // household after, and the people whose consent is being asked for last.
  //
  // Minus anybody a statute excused from signing. They are not sent a link,
  // and the amendment does not wait on them - which is the entire mechanical
  // difference between the two entry points.
  const signerParties = [
    ...staying.map((lt) => ({ id: lt.tenant.id, name: name(lt.tenant) })),
    ...incomingTenants.map((t) => ({ id: t.id, name: name(t) })),
    ...leaving.map((lt) => ({ id: lt.tenant.id, name: name(lt.tenant) })),
  ].filter((p) => !unsignedIds.has(p.id))
  const signers = orderedSigners({
    primaryTenant: signerParties[0] ?? null,
    otherTenants: signerParties.slice(1),
    guarantors: lease.guarantors.map((g) => ({ id: g.id, name: name(g) })),
  })

  const remainingNames = [
    ...staying.map((lt) => name(lt.tenant)),
    ...incomingTenants.map((t) => name(t)),
  ]

  const blocks = amendmentDocumentBlocks({
    propertyName: lease.property.name,
    propertyAddress: lease.property.addressLine1,
    unitName: lease.unit.name,
    entityName: lease.property.legalEntity.name,
    effectiveOn: input.effectiveOn,
    generatedOn,
    reason: input.reason,
    rentAmount: formatCents(lease.rentCents),
    depositAmount: formatCents(lease.depositCents),
    termStartsOn: utcToBusinessDate(lease.startsOn),
    termEndsOn: lease.endsOn ? utcToBusinessDate(lease.endsOn) : null,
    outgoingNames: leaving.map((lt) => name(lt.tenant)),
    incomingNames: incomingTenants.map((t) => name(t)),
    remainingNames,
    signers: signers.map((s) => ({
      order: s.order,
      role: s.role,
      name: s.name,
      signedAt: null,
      signedName: null,
    })),
  })

  const bytes = await renderBlocksPdf(blocks, {
    title: `Lease amendment — ${lease.property.name} ${lease.unit.name}`,
  })
  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `lease-amendment-draft-${lease.id}-${generatedOn}.pdf`
  const storageKey = generateStorageKey(lease.propertyId, fileName)
  // Stored before the row - orphaned-object-over-orphaned-row, same order as
  // every other archiver here.
  await storage.put(storageKey, buffer, 'application/pdf')

  const contacts = new Map<string, { email: string | null; phone: string | null }>()
  for (const lt of lease.leaseTenants) {
    contacts.set(lt.tenant.id, { email: lt.tenant.email, phone: lt.tenant.phone })
  }
  for (const t of incomingTenants) contacts.set(t.id, { email: t.email, phone: t.phone })
  for (const g of lease.guarantors) contacts.set(g.id, { email: g.email, phone: g.phone })

  const { changeId, envelopeId } = await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId: lease.propertyId,
        leaseId: lease.id,
        type: 'LEASE_AMENDMENT',
        fileName,
        contentType: 'application/pdf',
        sizeBytes: buffer.byteLength,
        storageKey,
        sha256,
        uploadedByStaffId: input.actorId,
      },
    })
    const envelope = await tx.leaseEnvelope.create({
      data: {
        leaseId: lease.id,
        kind: 'AMENDMENT',
        // No template. The amendment's text is the change itself - see
        // LeaseEnvelope.templateId's own comment.
        templateId: null,
        status: 'DRAFT',
        addendumKeys: [],
        draftDocumentId: document.id,
      },
    })
    const change = await tx.leasePartyChange.create({
      data: {
        leaseId: lease.id,
        status: 'PENDING_SIGNATURE',
        effectiveOn: new Date(`${input.effectiveOn}T00:00:00.000Z`),
        reason: input.reason,
        envelopeId: envelope.id,
        createdByStaffId: input.actorId,
        unsignedRemovalBasis: input.unsigned ? 'STATUTORY_EXEMPTION' : null,
        parties: {
          create: [
            ...outgoing.map((p) => ({ direction: 'OUTGOING' as const, tenantId: p.tenantId })),
            ...applicants.map((a) => ({
              direction: 'INCOMING' as const,
              tenantId: tenantByApplicant.get(a.id)!.id,
              applicantId: a.id,
            })),
          ],
        },
      },
    })
    for (const s of signers) {
      const contact = contacts.get(s.tenantId ?? s.guarantorId ?? '')
      await tx.leaseSigner.create({
        data: {
          envelopeId: envelope.id,
          order: s.order,
          role: s.role,
          name: s.name,
          email: contact?.email ?? null,
          phone: contact?.phone ?? null,
          tenantId: s.tenantId ?? null,
          guarantorId: s.guarantorId ?? null,
        },
      })
    }
    await audit(
      {
        action: 'lease.party_change_started',
        entityType: 'Lease',
        entityId: lease.id,
        propertyId: lease.propertyId,
        reason: input.reason,
        after: {
          changeId: change.id,
          envelopeId: envelope.id,
          effectiveOn: input.effectiveOn,
          outgoingTenantIds: outgoing.map((p) => p.tenantId),
          incoming: applicants.map((a) => ({
            applicantId: a.id,
            tenantId: tenantByApplicant.get(a.id)!.id,
            screeningDecision: a.screeningReport?.decision ?? null,
          })),
          // Says a statute excused a signature, and which people were not
          // asked for one. Never why, and never which statute - this payload
          // is what `audit.read` exposes broadly (D-107).
          unsignedRemovalBasis: input.unsigned ? 'STATUTORY_EXEMPTION' : null,
          unsignedTenantIds: [...unsignedIds],
          documentId: document.id,
          sha256,
        },
      },
      tx,
    )
    return { changeId: change.id, envelopeId: envelope.id }
  })

  const signerRows = await prisma.leaseSigner.findMany({
    where: { envelopeId },
    orderBy: { order: 'asc' },
  })

  let created: { providerId: string; signerProviderIds: Record<string, string> }
  try {
    created = await esignAdapter.createEnvelope({
      leaseId: lease.id,
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
    console.error(`[party-change] createEnvelope failed for lease ${lease.id}`, error)
    // The change and its DRAFT envelope stand. Withdrawing and starting
    // again is the recovery, rather than a retry that would generate a
    // second document for the same change.
    return {
      changeId,
      error:
        'Could not reach the e-signature provider. The amendment was saved — withdraw it and try again.',
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
        propertyId: lease.propertyId,
        after: {
          kind: 'AMENDMENT',
          changeId,
          signerCount: signerRows.length,
          provider: esignAdapter.name,
        },
      },
      tx,
    )
  })

  const summary = [
    leaving.length > 0 ? `${leaving.map((lt) => name(lt.tenant)).join(', ')} leaving` : null,
    incomingTenants.length > 0 ? `${incomingTenants.map((t) => name(t)).join(', ')} joining` : null,
  ]
    .filter(Boolean)
    .join(', ')

  for (const s of signerRows) {
    if (!s.email && !s.phone) continue
    const issued = await issueToken('LEASE_SIGN', { type: 'LeaseSigner', id: s.id })
    await notify({
      category: 'lease_signature',
      templateKey: 'lease.amendment_sign_invite',
      recipient: {
        type: s.role,
        id: s.tenantId ?? s.guarantorId ?? s.id,
        email: s.email,
        phone: s.phone,
      },
      context: {
        name: s.name,
        addressLine1: lease.property.addressLine1,
        summary,
        effectiveOn: input.effectiveOn,
        url: authUrl(`/sign/${issued.token}`),
      },
      propertyId: lease.propertyId,
      idempotencyKey: `party-change-sign-invite:${s.id}`,
    })
  }

  return { changeId, notice: 'Amendment sent to everybody for signature.' }
}
