'use server'

import { createHash } from 'node:crypto'
import {
  ADDENDUM_LABELS,
  type AddendumKey,
  activationGaps,
  applicableAddenda,
  leaseDocumentBlocks,
  leaseTransition,
  orderedSigners,
  renderTemplate,
} from '@rental/core/leases'
import { formatCents } from '@rental/core/money'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { issueToken } from '@/lib/auth/store.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { esignAdapter } from '@/lib/esign/provider.ts'
import { notify } from '@/lib/notifications/send.ts'
import { renderBlocksPdf } from '@/lib/pdf/render.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Generating a lease and sending it for e-signature (LEASE-06, DOC-02,
// R-063). Same shape every other `lib/*/actions.ts` here uses: a
// resource-carrying permission check first, a transaction pairing the write
// with its audit entry, and provider calls kept OUTSIDE any transaction
// (lib/screening/order.ts's own rule, restated for a fourth outbound call).
//
// OPERATES ON AN EXISTING DRAFT LEASE. Creating that lease - picking the
// unit, adding the tenants and any guarantor - is R-033's own `createLease`/
// `addLeaseTenant`/`addGuarantor`, unchanged; this item begins at "given a
// complete draft, generate the document and send it". See this item's own
// PROGRESS entry for why an Application-to-Lease bridge is not part of it.

export interface EsignFormState {
  error?: string
  notice?: string
}

const UTILITY_LABELS: Record<string, string> = {
  electricity: 'Electricity',
  gas: 'Gas',
  water: 'Water',
  sewer: 'Sewer',
  trash: 'Trash',
  internet: 'Internet',
  lawn: 'Lawn care',
  pest: 'Pest control',
}

async function leaseForEsign(leaseId: string) {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    include: {
      property: {
        select: {
          id: true,
          legalEntityId: true,
          name: true,
          addressLine1: true,
          state: true,
          county: true,
          timezone: true,
          yearBuilt: true,
          hasPool: true,
          hasWellOrSeptic: true,
          moldHistoryNotes: true,
          bedbugHistoryNotes: true,
          hoaInfo: { select: { id: true } },
          legalEntity: { select: { name: true } },
        },
      },
      unit: { select: { id: true, name: true } },
      leaseTenants: {
        include: { tenant: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
        orderBy: { isPrimary: 'desc' },
      },
      guarantors: true,
      recurringCharges: { where: { type: 'PET_RENT', active: true }, take: 1 },
      // R-090: LEASE only. Without it a live amendment on an in-force
      // lease would answer "this lease already has an envelope out for
      // signature" to a perfectly ordinary lease generation.
      envelopes: {
        where: { kind: 'LEASE', status: { not: 'VOIDED' } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })
  const actor = await requirePermission('lease.execute', propertyResource(lease.property))
  return { lease, actor }
}

/**
 * Finds the base LEASE template or one ADDENDUM template for a state,
 * preferring an exact-state match over the state-agnostic default. Returns
 * null rather than guessing - the caller refuses to generate a lease with a
 * missing base template or a triggered addendum with no text, per DOC-04's
 * own "fails loudly on a missing field" rule applied here to a missing
 * TEMPLATE.
 */
async function findTemplate(input: {
  documentType: 'LEASE' | 'ADDENDUM'
  addendumKey: AddendumKey | null
  state: string
}) {
  const candidates = await prisma.documentTemplate.findMany({
    where: {
      documentType: input.documentType,
      addendumKey: input.addendumKey,
      active: true,
      OR: [{ state: input.state }, { state: null }],
    },
    // Newest first - nothing stops two active templates sharing the same
    // (documentType, addendumKey, state) today, and if that ever happens
    // the most recently saved one is the better guess than an arbitrary
    // one. Retiring the stale duplicate is still the correct fix.
    orderBy: { createdAt: 'desc' },
  })
  return candidates.find((t) => t.state === input.state) ?? candidates.find((t) => t.state === null) ?? null
}

/**
 * Generates the lease document (base template + every applicable addendum,
 * merge fields resolved, blocks rendered to a PDF), archives it as an
 * unsigned draft, builds the signer list in order, and sends the envelope
 * through the e-sign provider - each signer getting their own LEASE_SIGN
 * link by email/SMS through the notification engine (R-030).
 *
 * IDEMPOTENT ON A DRAFT ENVELOPE: a previous call that generated the
 * document but failed to reach the provider left a DRAFT (unsent, no
 * providerId) envelope standing - this reuses it rather than generating a
 * second Document for the same lease. Anything already SENT or COMPLETED
 * refuses; void it first (`voidEnvelope` below) to start over.
 */
export async function generateAndSendLease(
  leaseId: string,
  _previous: EsignFormState,
  _formData: FormData,
): Promise<EsignFormState> {
  const { lease, actor } = await leaseForEsign(leaseId)

  // Routed through the same guarded machine every other status write here
  // uses (`changeLeaseStatus`'s own header: "nothing here sets `status`
  // directly") - DRAFT -> PENDING_SIGNATURE is the one leg of the machine
  // this action is allowed to take, and only from here.
  const toPending = leaseTransition(
    {
      status: lease.status,
      tenantCount: lease.leaseTenants.length,
      rentCents: lease.rentCents,
      startsOn: lease.startsOn,
      endsOn: lease.endsOn,
      isMonthToMonth: lease.isMonthToMonth,
    },
    'PENDING_SIGNATURE',
  )
  if (!toPending.allowed) return { error: toPending.message }

  const existing = lease.envelopes[0]
  if (existing && existing.status !== 'DRAFT') {
    return {
      error:
        'This lease already has an envelope out for signature. Void it before generating a new one.',
    }
  }

  const gaps = activationGaps({
    status: lease.status,
    tenantCount: lease.leaseTenants.length,
    rentCents: lease.rentCents,
    startsOn: lease.startsOn,
    endsOn: lease.endsOn,
    isMonthToMonth: lease.isMonthToMonth,
  })
  if (gaps.length > 0) {
    return { error: `This lease is not ready to send: ${gaps.join('; ')}.` }
  }
  if (lease.leaseTenants.length === 0) {
    return { error: 'Add at least one tenant before sending the lease for signature.' }
  }

  const template = await findTemplate({ documentType: 'LEASE', addendumKey: null, state: lease.property.state })
  if (!template) {
    return {
      error: `No lease template is configured for ${lease.property.state} (or a default). Add one at /documents/templates.`,
    }
  }

  const addendumKeys = applicableAddenda({
    yearBuilt: lease.property.yearBuilt,
    hasPool: lease.property.hasPool,
    hasWellOrSeptic: lease.property.hasWellOrSeptic,
    moldHistoryNotes: lease.property.moldHistoryNotes,
    bedbugHistoryNotes: lease.property.bedbugHistoryNotes,
    hasHoa: lease.property.hoaInfo != null,
  })
  const addendumTemplates: { key: AddendumKey; body: string }[] = []
  for (const key of addendumKeys) {
    const t = await findTemplate({ documentType: 'ADDENDUM', addendumKey: key, state: lease.property.state })
    if (!t) {
      return {
        error: `This property needs a ${ADDENDUM_LABELS[key]}, and no template is configured for it. Add one at /documents/templates before sending.`,
      }
    }
    addendumTemplates.push({ key, body: t.body })
  }

  const staff = await prisma.staffUser.findUniqueOrThrow({ where: { id: actor.id }, select: { name: true } })
  const generatedOn = businessDate(new Date(), lease.property.timezone)
  const startsOnLocal = utcToBusinessDate(lease.startsOn)
  const endsOnLocal = lease.endsOn ? utcToBusinessDate(lease.endsOn) : null
  const petCharge = lease.recurringCharges[0]

  const values: Record<string, string> = {
    'tenants.names': lease.leaseTenants
      .map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`)
      .join(', '),
    'guarantors.names':
      lease.guarantors.length > 0
        ? lease.guarantors.map((g) => `${g.firstName} ${g.lastName}`).join(', ')
        : 'None',
    'property.name': lease.property.name,
    'property.address': lease.property.addressLine1,
    'unit.name': lease.unit.name,
    'entity.name': lease.property.legalEntity.name,
    'term.starts_on': startsOnLocal,
    'term.ends_on': endsOnLocal ?? 'month-to-month',
    'rent.amount': formatCents(lease.rentCents),
    'rent.due_day': String(lease.rentDueDay),
    'deposit.amount': formatCents(lease.depositCents),
    'pet.terms': petCharge
      ? `A pet fee of ${formatCents(petCharge.amountCents)}/month applies.`
      : 'No pets are authorized under this lease.',
    today: generatedOn,
    'staff.name': staff.name,
  }

  const rendered = renderTemplate(template.body, values)
  if (rendered.missing.length > 0) {
    return { error: `Nothing to put in: ${rendered.missing.map((k) => `{{${k}}}`).join(', ')}.` }
  }

  const addenda: { key: AddendumKey; bodyText: string }[] = []
  for (const t of addendumTemplates) {
    const r = renderTemplate(t.body, values)
    if (r.missing.length > 0) {
      return {
        error: `The ${ADDENDUM_LABELS[t.key]} template is missing: ${r.missing.map((k) => `{{${k}}}`).join(', ')}.`,
      }
    }
    addenda.push({ key: t.key, bodyText: r.text })
  }

  const primary = lease.leaseTenants[0]!
  const signers = orderedSigners({
    primaryTenant: { id: primary.tenant.id, name: `${primary.tenant.firstName} ${primary.tenant.lastName}` },
    otherTenants: lease.leaseTenants
      .slice(1)
      .map((lt) => ({ id: lt.tenant.id, name: `${lt.tenant.firstName} ${lt.tenant.lastName}` })),
    guarantors: lease.guarantors.map((g) => ({ id: g.id, name: `${g.firstName} ${g.lastName}` })),
  })

  const blocks = leaseDocumentBlocks({
    propertyName: lease.property.name,
    propertyAddress: lease.property.addressLine1,
    unitName: lease.unit.name,
    startsOn: startsOnLocal,
    endsOn: endsOnLocal,
    rentAmount: values['rent.amount']!,
    depositAmount: values['deposit.amount']!,
    generatedOn,
    bodyText: rendered.text,
    addenda,
    utilities: (lease.utilityResponsibility ?? {}) as Record<string, string>,
    utilityLabels: UTILITY_LABELS,
    signers: signers.map((s) => ({ order: s.order, role: s.role, name: s.name, signedAt: null, signedName: null })),
  })

  const bytes = await renderBlocksPdf(blocks, {
    title: `Lease — ${lease.property.name} ${lease.unit.name}`,
  })
  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `lease-draft-${leaseId}.pdf`
  const storageKey = generateStorageKey(lease.propertyId, fileName)
  // Stored before the row - orphaned-object-over-orphaned-row, the same
  // order every other archiver here uses.
  await storage.put(storageKey, buffer, 'application/pdf')

  const signerContacts = new Map<string, { email: string | null; phone: string | null }>()
  for (const lt of lease.leaseTenants) {
    signerContacts.set(lt.tenant.id, { email: lt.tenant.email, phone: lt.tenant.phone })
  }
  for (const g of lease.guarantors) {
    signerContacts.set(g.id, { email: g.email, phone: g.phone })
  }

  const envelopeId = await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId: lease.propertyId,
        leaseId: lease.id,
        type: 'LEASE',
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
        leaseId: lease.id,
        templateId: template.id,
        status: 'DRAFT',
        addendumKeys,
        draftDocumentId: document.id,
      },
    })
    for (const s of signers) {
      const contact = signerContacts.get(s.tenantId ?? s.guarantorId ?? '')
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
        action: 'document.generated',
        entityType: 'Document',
        entityId: document.id,
        propertyId: lease.propertyId,
        after: { leaseId: lease.id, templateId: template.id, addendumKeys, sha256, sizeBytes: buffer.byteLength },
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
      leaseId: lease.id,
      documentSha256: sha256,
      signers: signerRows.map((s) => ({ localId: s.id, order: s.order, role: s.role, name: s.name, email: s.email })),
    })
  } catch (error) {
    console.error(`[esign] createEnvelope failed for lease ${leaseId}`, error)
    revalidatePath(`/leases/${leaseId}`)
    // The draft envelope and its document are already saved and stay
    // DRAFT - re-running this action reuses them and retries the send,
    // rather than generating a second document.
    return { error: 'Could not reach the e-signature provider. The draft was saved — try sending again.' }
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
    await tx.lease.update({ where: { id: leaseId }, data: { status: 'PENDING_SIGNATURE' } })
    await audit(
      {
        action: 'envelope.sent',
        entityType: 'LeaseEnvelope',
        entityId: envelopeId,
        propertyId: lease.propertyId,
        after: {
          templateId: template.id,
          addendumKeys,
          signerCount: signerRows.length,
          provider: esignAdapter.name,
        },
      },
      tx,
    )
    await audit(
      {
        action: 'lease.status_changed',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        before: { status: 'DRAFT' },
        after: { status: 'PENDING_SIGNATURE', byStaffId: actor.id },
      },
      tx,
    )
  })

  // One link per signer, outside the transaction - notify() has its own
  // resilience (R-016's outbox), so a failed send here does not roll back
  // the envelope the way a failed provider call above does.
  for (const s of signerRows) {
    if (!s.email && !s.phone) continue
    const issued = await issueToken('LEASE_SIGN', { type: 'LeaseSigner', id: s.id })
    await notify({
      category: 'lease_signature',
      templateKey: 'lease.sign_invite',
      recipient: {
        type: s.role,
        id: s.tenantId ?? s.guarantorId ?? s.id,
        email: s.email,
        phone: s.phone,
      },
      context: { name: s.name, addressLine1: lease.property.addressLine1, url: authUrl(`/sign/${issued.token}`) },
      propertyId: lease.propertyId,
      idempotencyKey: `lease-sign-invite:${s.id}`,
    })
  }

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Sent for signature.' }
}

/**
 * Abandons a sent-but-unsigned envelope so the lease can be regenerated -
 * REASON_REQUIRED, the same call `lease.terminated` makes: withdrawing a
 * document already sent for a legal signature needs a stated reason on the
 * record. Does not touch the lease's own status (still PENDING_SIGNATURE);
 * a fresh `generateAndSendLease` call is what moves it forward again.
 */
export async function voidEnvelope(
  leaseId: string,
  _previous: EsignFormState,
  formData: FormData,
): Promise<EsignFormState> {
  const { lease } = await leaseForEsign(leaseId)
  const reason = typeof formData.get('reason') === 'string' ? (formData.get('reason') as string).trim() : ''
  if (!reason) return { error: 'Say why this envelope is being withdrawn.' }

  const envelope = lease.envelopes[0]
  if (!envelope || envelope.status === 'COMPLETED') {
    return { error: 'There is no sendable envelope to void.' }
  }

  if (envelope.providerId) {
    await esignAdapter.voidEnvelope({ providerId: envelope.providerId, reason }).catch((error: unknown) => {
      console.error(`[esign] provider void failed for envelope ${envelope.id}`, error)
    })
  }

  await prisma.$transaction(async (tx) => {
    await tx.leaseEnvelope.update({
      where: { id: envelope.id },
      data: { status: 'VOIDED', voidedAt: new Date() },
    })
    await audit(
      {
        action: 'envelope.voided',
        entityType: 'LeaseEnvelope',
        entityId: envelope.id,
        propertyId: lease.propertyId,
        reason,
      },
      tx,
    )
  })

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Envelope withdrawn. Generate a new one when ready.' }
}
