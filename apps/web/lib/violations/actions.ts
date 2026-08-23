'use server'

import { createHash } from 'node:crypto'
import { businessDate, businessDateToUtc } from '@rental/core/scheduling'
import {
  isViolationGround,
  isViolationKind,
  isViolationOutcome,
  validateClosure,
  validateObservation,
  type ViolationKind,
} from '@rental/core/violations'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { extractCapturedAt } from '@/lib/documents/exif.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import { accommodationPosture, getViolationCase } from '@/lib/violations/queries.ts'

// Writes for lease-violation case files (RISK-02, RISK-03; R-088).
//
// ==========================================================================
// OPENING AND OBSERVING ARE `lease.write`. ESCALATING IS `eviction.manage`.
//
// R-087 put the whole abandonment workflow behind `eviction.manage` because
// every step of it leads to entering somebody's home. This one does not: the
// commonest real outcome of finding an unauthorized occupant is that they
// apply and stay, and a leasing agent who cannot record what they saw records
// nothing at all. Recording is the SAFE direction and it is deliberately
// cheap.
//
// Escalating to eviction is the eviction act, so it is behind the eviction
// permission — the same idiom D-81 uses for `hold.lift_protected`: a more
// consequential variant of the same act gets its own permission rather than a
// role hierarchy this product does not have.
// ==========================================================================

export interface ViolationFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

async function caseForWrite(caseId: string) {
  const actor = await requirePermission('lease.write')
  const scope = await currentScope(actor)
  const found = await getViolationCase(caseId, scope)
  if (!found) return null
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: found.propertyId },
    select: { id: true, legalEntityId: true },
  })
  await requirePermission('lease.write', propertyResource(property))
  return { found, actor }
}

export async function openViolationCase(
  leaseId: string,
  _previous: ViolationFormState,
  formData: FormData,
): Promise<ViolationFormState> {
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      unitId: true,
      status: true,
      property: { select: { id: true, legalEntityId: true, timezone: true } },
    },
  })
  if (!lease) return { error: 'That tenancy no longer exists.' }

  const actor = await requirePermission('lease.write', propertyResource(lease.property))

  if (lease.status !== 'ACTIVE' && lease.status !== 'MONTH_TO_MONTH') {
    return { error: 'Only a running tenancy can be in breach of its own terms.' }
  }

  const kind = str(formData, 'kind')
  const ground = str(formData, 'ground')
  const observedOn = str(formData, 'observedOn')
  const note = str(formData, 'note')

  if (!isViolationKind(kind)) {
    return { error: 'Fix the highlighted fields.', fieldErrors: { kind: 'What is being alleged?' } }
  }

  const today = businessDate(new Date(), lease.property.timezone)
  const groundValue = kind === 'PREMISES_CONDITION' && isViolationGround(ground) ? ground : null

  const fieldErrors: Record<string, string> = {}
  if (!observedOn) fieldErrors.observedOn = 'When was it seen?'
  for (const violation of validateObservation(
    { kind, ground: groundValue, observedOn: observedOn || today, note },
    today,
  )) {
    fieldErrors[violation.field] = violation.message
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  // A case is opened with its first observation in the same transaction. A
  // case with no observation is an allegation with nothing behind it, and the
  // two-step version leaves one on the record every time somebody is
  // interrupted.
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.violationCase.create({
      data: {
        propertyId: lease.propertyId,
        unitId: lease.unitId,
        leaseId,
        kind,
        openedByStaffId: actor.id,
      },
    })
    await tx.violationObservation.create({
      data: {
        caseId: row.id,
        ground: groundValue,
        observedOn: businessDateToUtc(observedOn),
        note,
        recordedByStaffId: actor.id,
      },
    })
    return row
  })

  await audit({
    action: 'violation.case_opened',
    entityType: 'ViolationCase',
    entityId: created.id,
    propertyId: lease.propertyId,
    reason: note,
    after: { leaseId, kind, ground: groundValue, observedOn },
  })

  revalidatePath(`/leases/${leaseId}`)
  revalidatePath('/violations')
  redirect(`/violations/${created.id}`)
}

export async function recordObservation(
  _previous: ViolationFormState,
  formData: FormData,
): Promise<ViolationFormState> {
  // From the form, not a bound argument — a `(id) => action` factory has no
  // identity the client can call back to.
  const caseId = str(formData, 'caseId')
  if (!caseId) return { error: 'No case named.' }

  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found, actor } = context

  if (found.status === 'CLOSED') return { error: 'This case is closed.' }

  const ground = str(formData, 'ground')
  const observedOn = str(formData, 'observedOn')
  const note = str(formData, 'note')
  const today = businessDate(new Date(), found.timezone)
  const groundValue = found.kind === 'PREMISES_CONDITION' && isViolationGround(ground) ? ground : null

  const fieldErrors: Record<string, string> = {}
  if (!observedOn) fieldErrors.observedOn = 'When was it seen?'
  for (const violation of validateObservation(
    { kind: found.kind, ground: groundValue, observedOn: observedOn || today, note },
    today,
  )) {
    fieldErrors[violation.field] = violation.message
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  const observation = await prisma.violationObservation.create({
    data: {
      caseId,
      ground: groundValue,
      observedOn: businessDateToUtc(observedOn),
      note,
      recordedByStaffId: actor.id,
    },
  })

  const file = formData.get('photo')
  if (file instanceof File && file.size > 0) {
    await archive({
      file,
      observationId: observation.id,
      propertyId: found.propertyId,
      staffId: actor.id,
    })
  }

  await audit({
    action: 'violation.observed',
    entityType: 'ViolationCase',
    entityId: caseId,
    propertyId: found.propertyId,
    after: { observationId: observation.id, ground: groundValue, observedOn, note },
  })

  revalidatePath(`/violations/${caseId}`)
  return { notice: 'Observation recorded.' }
}

async function archive(params: {
  file: File
  observationId: string
  propertyId: string
  staffId: string
}): Promise<void> {
  const buffer = Buffer.from(await params.file.arrayBuffer())
  const contentType = params.file.type || 'application/octet-stream'
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  // The photo's own timestamp is the evidence. A hoarding file is a series of
  // dated visits, and a picture that cannot say when it was taken shows a
  // condition existed at some point — which is not what anybody is arguing
  // about.
  const capturedAt = await extractCapturedAt(buffer, contentType)
  const storageKey = generateStorageKey(params.propertyId, params.file.name)
  await storage.put(storageKey, buffer, contentType)

  await prisma.document.create({
    data: {
      propertyId: params.propertyId,
      violationObservationId: params.observationId,
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
}

/**
 * Attach an accommodation request to this case.
 *
 * A hoarding case and the accommodation asked for in response to it are the
 * same conversation. Linking is what makes closing as ACCOMMODATED possible at
 * all — `validateClosure` reads the LINKED requests rather than every request
 * on the tenancy, so "we accommodated them" has to name which accommodation.
 */
export async function linkAccommodationRequest(
  _previous: ViolationFormState,
  formData: FormData,
): Promise<ViolationFormState> {
  const caseId = str(formData, 'caseId')
  const requestId = str(formData, 'requestId')
  if (!caseId || !requestId) return { error: 'No case or request named.' }

  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found } = context

  const request = await prisma.accommodationRequest.findUnique({
    where: { id: requestId },
    select: { id: true, leaseId: true, violationCaseId: true },
  })
  if (!request || request.leaseId !== found.leaseId) {
    return { error: 'That request is not on this tenancy.' }
  }
  if (request.violationCaseId) {
    return { error: 'That request is already attached to a case.' }
  }

  await prisma.accommodationRequest.update({
    where: { id: requestId },
    data: { violationCaseId: caseId },
  })

  revalidatePath(`/violations/${caseId}`)
  return { notice: 'Request attached to this case.' }
}

/**
 * Close the case.
 *
 * ==========================================================================
 * THE PERMISSION DEPENDS ON THE OUTCOME, and only here.
 *
 * Every outcome but one is `lease.write`: cured, legitimized, accommodated
 * and withdrawn are all a leasing person recording what happened, and three
 * of the four are the tenant keeping their home. `ESCALATED` hands the matter
 * to the eviction path and is behind `eviction.manage` — the permission R-083
 * created precisely so leasing and notice-serving could be handed out without
 * it.
 * ==========================================================================
 */
export async function closeViolationCase(
  _previous: ViolationFormState,
  formData: FormData,
): Promise<ViolationFormState> {
  const caseId = str(formData, 'caseId')
  if (!caseId) return { error: 'No case named.' }

  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found } = context

  if (found.status === 'CLOSED') return { error: 'This case is already closed.' }

  const outcome = str(formData, 'outcome')
  if (!isViolationOutcome(outcome)) {
    return { error: 'Fix the highlighted fields.', fieldErrors: { outcome: 'How did this end?' } }
  }

  if (outcome === 'ESCALATED') {
    const property = await prisma.property.findUniqueOrThrow({
      where: { id: found.propertyId },
      select: { id: true, legalEntityId: true },
    })
    await requirePermission('eviction.manage', propertyResource(property))
  }

  const outcomeNote = str(formData, 'outcomeNote')
  const legitimizedApplicantId = str(formData, 'legitimizedApplicantId') || null
  const authorizedAnimal = str(formData, 'authorizedAnimal') || null
  const overrideReason = str(formData, 'overrideReason') || null

  const posture = await accommodationPosture(found.leaseId)
  // The approved request has to be one attached to THIS case, not merely one
  // on the tenancy. "We accommodated them" that cannot say which
  // accommodation is the sentence, not the record.
  const linkedApproved = found.accommodationRequests.find((r) => r.status === 'APPROVED') ?? null

  let screened = false
  if (legitimizedApplicantId) {
    const report = await prisma.screeningReport.findUnique({
      where: { applicantId: legitimizedApplicantId },
      select: { decision: true },
    })
    screened = Boolean(report?.decision)
  }

  const { violations, warnings } = validateClosure({
    kind: found.kind as ViolationKind,
    outcome,
    outcomeNote,
    legitimizedApplicantId,
    legitimizedApplicantScreened: screened,
    authorizedAnimal,
    approvedAccommodationId: linkedApproved?.id ?? null,
    hasUndecidedRequest: posture.hasUndecidedRequest,
    overrideReason,
  })

  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  await prisma.violationCase.update({
    where: { id: caseId },
    data: {
      status: 'CLOSED',
      outcome,
      outcomeNote,
      overrideReason,
      closedAt: new Date(),
      // Written only where the outcome is the one that needs them, so a
      // legitimized animal cannot end up carrying an applicant id from an
      // abandoned earlier attempt.
      legitimizedApplicantId: outcome === 'LEGITIMIZED' ? legitimizedApplicantId : null,
      authorizedAnimal: outcome === 'LEGITIMIZED' ? authorizedAnimal : null,
    },
  })

  await audit({
    action: 'violation.case_closed',
    entityType: 'ViolationCase',
    entityId: caseId,
    propertyId: found.propertyId,
    reason: outcomeNote,
    after: {
      outcome,
      legitimizedApplicantId: outcome === 'LEGITIMIZED' ? legitimizedApplicantId : null,
      legitimizedApplicantScreened: screened,
      authorizedAnimal: outcome === 'LEGITIMIZED' ? authorizedAnimal : null,
      accommodationRequestId: linkedApproved?.id ?? null,
      overrideReason,
    },
  })

  revalidatePath(`/violations/${caseId}`)
  revalidatePath('/violations')
  revalidatePath(`/leases/${found.leaseId}`)
  return { notice: warnings.length > 0 ? warnings.join(' ') : 'Case closed.' }
}
