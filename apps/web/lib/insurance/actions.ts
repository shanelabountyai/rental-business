'use server'

import { createHash } from 'node:crypto'
import {
  isCauseOfLoss,
  isClaimEventKind,
  isClaimOutcome,
  isPaymentCategory,
  validateClaimClosure,
} from '@rental/core/insurance'
import { businessDate, businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { extractCapturedAt } from '@/lib/documents/exif.ts'
import { getClaim } from '@/lib/insurance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Writes for insurance claims (RISK-07, R-089).
//
// `property.write`, not `ledger.adjust` or `payment.record`. Those two guard
// the tenant ledger, which this never touches: `LedgerEntry` is strictly
// lease-scoped and a carrier's cheque belongs to no tenancy. A claim is a
// property-level record and it sits behind the property's own permission,
// the same place mortgages, policies and capital improvements already sit.

export interface ClaimFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

function cents(formData: FormData, key: string): number | null {
  const raw = str(formData, key)
  if (!raw) return null
  // Dollars in, integer cents stored. `Math.round` rather than a truncation:
  // 12.345 typed off a settlement letter is a typo, not a licence to lose a
  // cent, and rounding at least keeps the sum honest.
  const dollars = Number(raw.replace(/[$,]/g, ''))
  if (!Number.isFinite(dollars)) return null
  return Math.round(dollars * 100)
}

/// A local datetime string from a form, in the property's zone.
function instant(value: string): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

async function claimForWrite(claimId: string) {
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor } = await requireScope('property.write')
  const scope = await currentScope(actor)
  const found = await getClaim(claimId, scope)
  if (!found) return null
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: found.propertyId },
    select: { id: true, legalEntityId: true },
  })
  await requirePermission('property.write', propertyResource(property))
  return { found, actor }
}

export async function openClaim(
  propertyId: string,
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, legalEntityId: true, timezone: true },
  })
  if (!property) return { error: 'That property no longer exists.' }

  const actor = await requirePermission('property.write', propertyResource(property))

  const policyId = str(formData, 'policyId')
  const cause = str(formData, 'cause')
  const description = str(formData, 'description')
  const incidentAt = instant(str(formData, 'incidentAt'))
  const mitigationStartedAt = instant(str(formData, 'mitigationStartedAt'))

  const fieldErrors: Record<string, string> = {}
  if (!policyId) {
    fieldErrors.policyId =
      'Which policy is this under? A claim against no policy on file is one nobody can evaluate — the deductible and whether loss of rents is covered both come from the policy, not from here.'
  }
  if (!isCauseOfLoss(cause)) fieldErrors.cause = 'What caused the loss?'
  if (description.trim().length < 20) {
    fieldErrors.description =
      'Describe the loss. This is what gets read back to you by an adjuster who was not there, months later.'
  }
  if (!incidentAt) fieldErrors.incidentAt = 'When did the loss happen?'

  const now = new Date()
  if (incidentAt && incidentAt > now) {
    fieldErrors.incidentAt = 'A loss cannot be recorded in the future.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  const policy = await prisma.insurancePolicy.findFirst({
    where: { id: policyId, propertyId },
    select: { id: true },
  })
  if (!policy) return { error: 'That policy is not on this property.' }

  const created = await prisma.insuranceClaim.create({
    data: {
      propertyId,
      policyId,
      cause: cause as 'WATER',
      description,
      incidentAt: incidentAt!,
      mitigationStartedAt,
      claimNumber: str(formData, 'claimNumber') || null,
      openedByStaffId: actor.id,
    },
  })

  await audit({
    action: 'claim.opened',
    entityType: 'InsuranceClaim',
    entityId: created.id,
    propertyId,
    after: {
      policyId,
      cause,
      incidentAt: incidentAt!.toISOString(),
      mitigationStartedAt: mitigationStartedAt?.toISOString() ?? null,
    },
  })

  revalidatePath(`/properties/${propertyId}`)
  revalidatePath('/claims')
  redirect(`/claims/${created.id}`)
}

/**
 * Record the claim's own details as they arrive: the carrier's number, the
 * adjuster, when it was reported, when mitigation started.
 *
 * One action rather than four, because they arrive in one phone call. A claim
 * number is assigned, an adjuster is named and a reporting time is confirmed
 * in the same two minutes, and four separate forms is four chances to record
 * one of them and get distracted.
 */
export async function updateClaimDetails(
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const claimId = str(formData, 'claimId')
  if (!claimId) return { error: 'No claim named.' }

  const context = await claimForWrite(claimId)
  if (!context) return { error: 'That claim no longer exists.' }
  const { found } = context

  if (found.status === 'CLOSED') return { error: 'This claim is closed.' }

  const mitigationStartedAt = instant(str(formData, 'mitigationStartedAt'))
  const reportedAt = instant(str(formData, 'reportedAt'))

  if (mitigationStartedAt && mitigationStartedAt < found.incidentAt) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: {
        mitigationStartedAt: 'Mitigation cannot have started before the loss did.',
      },
    }
  }

  await prisma.insuranceClaim.update({
    where: { id: claimId },
    data: {
      claimNumber: str(formData, 'claimNumber') || null,
      adjusterName: str(formData, 'adjusterName') || null,
      adjusterCompany: str(formData, 'adjusterCompany') || null,
      adjusterPhone: str(formData, 'adjusterPhone') || null,
      adjusterEmail: str(formData, 'adjusterEmail') || null,
      mitigationStartedAt,
      reportedAt,
    },
  })

  revalidatePath(`/claims/${claimId}`)
  return { notice: 'Claim details saved.' }
}

/** Attach a work order to the claim — the only thing that gives it a cost. */
export async function linkWorkOrder(
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const claimId = str(formData, 'claimId')
  const workOrderId = str(formData, 'workOrderId')
  if (!claimId || !workOrderId) return { error: 'No claim or job named.' }

  const context = await claimForWrite(claimId)
  if (!context) return { error: 'That claim no longer exists.' }
  const { found } = context
  if (found.status === 'CLOSED') return { error: 'This claim is closed.' }

  const job = await prisma.workOrder.findUnique({
    where: { id: workOrderId },
    select: { id: true, propertyId: true, insuranceClaimId: true, scope: true },
  })
  if (!job || job.propertyId !== found.propertyId) {
    return { error: 'That job is not at this property.' }
  }
  if (job.insuranceClaimId) {
    return {
      error:
        job.insuranceClaimId === claimId
          ? 'That job is already on this claim.'
          : 'That job is already being recovered under another claim. Two claims naming one job would each report its cost as theirs.',
    }
  }

  await prisma.workOrder.update({
    where: { id: workOrderId },
    data: { insuranceClaimId: claimId },
  })

  revalidatePath(`/claims/${claimId}`)
  revalidatePath(`/workorders/${workOrderId}`)
  return { notice: `Job "${job.scope}" attached. Its recorded cost is now part of this claim.` }
}

export async function unlinkWorkOrder(
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const claimId = str(formData, 'claimId')
  const workOrderId = str(formData, 'workOrderId')
  if (!claimId || !workOrderId) return { error: 'No claim or job named.' }

  const context = await claimForWrite(claimId)
  if (!context) return { error: 'That claim no longer exists.' }
  if (context.found.status === 'CLOSED') return { error: 'This claim is closed.' }

  await prisma.workOrder.updateMany({
    where: { id: workOrderId, insuranceClaimId: claimId },
    data: { insuranceClaimId: null },
  })

  revalidatePath(`/claims/${claimId}`)
  return { notice: 'Job removed from this claim.' }
}

/**
 * Record money that actually arrived.
 *
 * The category is required and it is the only field here that cannot be
 * recovered later: loss-of-rents proceeds are income and damage proceeds are
 * not, and the difference is knowable exactly once — while the cheque and its
 * covering letter are in front of somebody. Next January the bank line says
 * "CLAIM SETTLEMENT" and nothing else.
 */
export async function recordClaimPayment(
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const claimId = str(formData, 'claimId')
  if (!claimId) return { error: 'No claim named.' }

  const context = await claimForWrite(claimId)
  if (!context) return { error: 'That claim no longer exists.' }
  const { found, actor } = context

  const category = str(formData, 'category')
  const amountCents = cents(formData, 'amount')
  const receivedOn = str(formData, 'receivedOn')

  const fieldErrors: Record<string, string> = {}
  if (!isPaymentCategory(category)) fieldErrors.category = 'What was this payment for?'
  if (amountCents == null || amountCents <= 0) {
    fieldErrors.amount =
      'How much arrived? A carrier clawing money back is a real event — record it as a note on the timeline, not as a negative payment that would quietly reduce reported income.'
  }
  if (!receivedOn) fieldErrors.receivedOn = 'When did it arrive?'

  const today = businessDate(new Date(), found.timezone)
  if (receivedOn && receivedOn > today) {
    fieldErrors.receivedOn = 'That date is in the future.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  const payment = await prisma.insuranceClaimPayment.create({
    data: {
      claimId,
      category: category as 'REPAIR',
      amountCents: amountCents!,
      receivedOn: businessDateToUtc(receivedOn),
      reference: str(formData, 'reference') || null,
      note: str(formData, 'note') || null,
      recordedByStaffId: actor.id,
    },
  })

  await audit({
    action: 'claim.payment_recorded',
    entityType: 'InsuranceClaim',
    entityId: claimId,
    propertyId: found.propertyId,
    after: {
      paymentId: payment.id,
      category,
      amountCents: amountCents!,
      receivedOn,
      reference: payment.reference,
    },
  })

  revalidatePath(`/claims/${claimId}`)
  const surprise =
    category === 'LOSS_OF_RENTS' && !found.lossOfRentsCovered
      ? ' The policy on file is not recorded as carrying loss-of-rents cover — worth checking the policy record is current.'
      : ''
  return {
    notice: `Payment recorded. It reaches the tax export as ${
      category === 'LOSS_OF_RENTS' ? 'rental income' : 'a counted exception for your preparer'
    }.${surprise}`,
  }
}

/** One timeline or correspondence entry, with the paper behind it. */
export async function logClaimEvent(
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const claimId = str(formData, 'claimId')
  if (!claimId) return { error: 'No claim named.' }

  const context = await claimForWrite(claimId)
  if (!context) return { error: 'That claim no longer exists.' }
  const { found, actor } = context

  const kind = str(formData, 'kind')
  const occurredAt = instant(str(formData, 'occurredAt'))
  const note = str(formData, 'note')

  const fieldErrors: Record<string, string> = {}
  if (!isClaimEventKind(kind)) fieldErrors.kind = 'What happened?'
  if (!occurredAt) fieldErrors.occurredAt = 'When?'
  if (note.trim().length < 5) {
    fieldErrors.note = 'Write down what was said. "Spoke to adjuster" is not a record of anything.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  const file = formData.get('document')
  const documentId =
    file instanceof File && file.size > 0
      ? await archive({ file, propertyId: found.propertyId, staffId: actor.id, claimId: null })
      : null

  const event = await prisma.insuranceClaimEvent.create({
    data: {
      claimId,
      kind: kind as 'NOTE',
      occurredAt: occurredAt!,
      note,
      documentId,
      recordedByStaffId: actor.id,
    },
  })

  await audit({
    action: 'claim.event_logged',
    entityType: 'InsuranceClaim',
    entityId: claimId,
    propertyId: found.propertyId,
    after: { eventId: event.id, kind, occurredAt: occurredAt!.toISOString(), note, documentId },
  })

  revalidatePath(`/claims/${claimId}`)
  return { notice: 'Logged.' }
}

/**
 * Loss photographs, uploaded at the claim rather than at an event.
 *
 * Its own action with nothing else in the form, because of when it gets used:
 * standing in the property on the day, one-handed. Anything that made a photo
 * wait for a category, a date and a note is a photo that does not get taken.
 */
export async function uploadLossPhoto(
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const claimId = str(formData, 'claimId')
  if (!claimId) return { error: 'No claim named.' }

  const context = await claimForWrite(claimId)
  if (!context) return { error: 'That claim no longer exists.' }
  const { found, actor } = context

  const files = formData.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0)
  if (files.length === 0) return { error: 'Choose at least one file.' }

  for (const file of files) {
    await archive({ file, propertyId: found.propertyId, staffId: actor.id, claimId })
  }

  revalidatePath(`/claims/${claimId}`)
  return {
    notice: `${files.length} file${files.length === 1 ? '' : 's'} attached. Each one keeps its own capture timestamp, which is what makes it evidence of when.`,
  }
}

async function archive(params: {
  file: File
  propertyId: string
  staffId: string
  claimId: string | null
}): Promise<string> {
  const buffer = Buffer.from(await params.file.arrayBuffer())
  const contentType = params.file.type || 'application/octet-stream'
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  // Returns null for anything without EXIF, video included — the column is
  // nullable and the claim page says plainly which files carry a timestamp
  // and which do not, rather than implying all of them do.
  const capturedAt = await extractCapturedAt(buffer, contentType)
  const storageKey = generateStorageKey(params.propertyId, params.file.name)
  await storage.put(storageKey, buffer, contentType)

  const document = await prisma.document.create({
    data: {
      propertyId: params.propertyId,
      insuranceClaimId: params.claimId,
      type: 'UNIT_PHOTO',
      fileName: params.file.name,
      contentType,
      sizeBytes: params.file.size,
      storageKey,
      sha256,
      capturedAt,
      uploadedByStaffId: params.staffId,
    },
  })
  return document.id
}

/** Record the downtime a loss-of-rents figure is built from. */
export async function recordLossOfRents(
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const claimId = str(formData, 'claimId')
  if (!claimId) return { error: 'No claim named.' }

  const context = await claimForWrite(claimId)
  if (!context) return { error: 'That claim no longer exists.' }
  const { found } = context
  if (found.status === 'CLOSED') return { error: 'This claim is closed.' }

  const unitId = str(formData, 'unitId')
  const fromOn = str(formData, 'lossOfRentsFromOn')
  const toOn = str(formData, 'lossOfRentsToOn')

  const fieldErrors: Record<string, string> = {}
  if (!unitId) fieldErrors.unitId = 'Which unit was down?'
  if (!fromOn) fieldErrors.lossOfRentsFromOn = 'From when?'
  if (!toOn) fieldErrors.lossOfRentsToOn = 'Until when?'
  if (fromOn && toOn && toOn < fromOn) {
    fieldErrors.lossOfRentsToOn = 'The period ends before it starts.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  const unit = await prisma.unit.findFirst({
    where: { id: unitId, propertyId: found.propertyId },
    select: { id: true, marketRentCents: true },
  })
  if (!unit) return { error: 'That unit is not at this property.' }

  // ==========================================================================
  // THE LEASE IS FOUND, NOT ASKED FOR, AND THE RENT IS NEVER TYPED.
  //
  // The tenancy that was in the unit when the loss happened is the one whose
  // rent was lost, and the database already knows which that was. Asking
  // somebody to pick a lease invites picking the wrong one; asking for the
  // rent invites a third copy of a number that is already on the lease and on
  // the unit (D-19's discipline, applied outside maintenance).
  // ==========================================================================
  const lease = await prisma.lease.findFirst({
    where: {
      unitId,
      startsOn: { lte: businessDateToUtc(fromOn) },
      OR: [{ endsOn: null }, { endsOn: { gte: businessDateToUtc(fromOn) } }],
    },
    orderBy: { startsOn: 'desc' },
    select: { id: true },
  })

  if (!lease && unit.marketRentCents == null) {
    return {
      error:
        'No tenancy covered this unit on that date and the unit has no asking rent recorded, so there is no rent to build a figure from. Record the unit’s market rent, or pick the period the tenancy actually covered.',
    }
  }

  await prisma.insuranceClaim.update({
    where: { id: claimId },
    data: {
      lossOfRentsUnitId: unitId,
      lossOfRentsLeaseId: lease?.id ?? null,
      lossOfRentsFromOn: businessDateToUtc(fromOn),
      lossOfRentsToOn: businessDateToUtc(toOn),
    },
  })

  revalidatePath(`/claims/${claimId}`)
  return {
    notice: lease
      ? 'Recorded against the rent this tenancy was actually paying — the strongest evidence there is.'
      : 'No tenancy covered that period, so the figure is built on the unit’s asking rent. A carrier will discount that, and the claim file says which was used.',
  }
}

export async function closeClaim(
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const claimId = str(formData, 'claimId')
  if (!claimId) return { error: 'No claim named.' }

  const context = await claimForWrite(claimId)
  if (!context) return { error: 'That claim no longer exists.' }
  const { found } = context
  if (found.status === 'CLOSED') return { error: 'This claim is already closed.' }

  const outcome = str(formData, 'outcome')
  if (!isClaimOutcome(outcome)) {
    return { error: 'Fix the highlighted fields.', fieldErrors: { outcome: 'How did this end?' } }
  }
  const outcomeNote = str(formData, 'outcomeNote')

  const violations = validateClaimClosure({
    outcome,
    outcomeNote,
    paidCents: found.position.paidCents,
  })
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  await prisma.insuranceClaim.update({
    where: { id: claimId },
    data: { status: 'CLOSED', outcome, outcomeNote, closedAt: new Date() },
  })

  await audit({
    action: 'claim.closed',
    entityType: 'InsuranceClaim',
    entityId: claimId,
    propertyId: found.propertyId,
    reason: outcomeNote,
    after: {
      outcome,
      paidCents: found.position.paidCents,
      repairCostCents: found.position.repairCostCents,
      shortfallCents: found.position.shortfallCents,
    },
  })

  revalidatePath(`/claims/${claimId}`)
  revalidatePath('/claims')
  revalidatePath(`/properties/${found.propertyId}`)
  return { notice: 'Claim closed.' }
}
