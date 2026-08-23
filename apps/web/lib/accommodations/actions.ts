'use server'

import { createHash } from 'node:crypto'
import {
  DOCUMENTATION_REFUSAL_MESSAGES,
  documentationRequestable,
  isAccommodationKind,
  validateDetermination,
} from '@rental/core/accommodations'
import { businessDate, businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { extractCapturedAt } from '@/lib/documents/exif.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import { createTask } from '@/lib/tasks/create.ts'

// Writes for assistance-animal accommodation requests (RISK-13, R-086).
//
// `lease.write` throughout. Deliberately NOT a new permission: deciding a
// reasonable-accommodation request is squarely the job of whoever runs the
// tenancy, and putting it behind something rarer would make the commonest
// failure - nobody answering - more likely, not less. The controls that
// matter here are the written record and the clock, not scarcity of access.

export interface AccommodationFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
  /// WHAT WAS TYPED, HANDED BACK ON A REFUSAL.
  ///
  /// A React 19 form action resets its uncontrolled fields when it returns,
  /// so a validation failure otherwise empties the form - including the
  /// determination text somebody just wrote three paragraphs of. The same
  /// `values` echo `recordLeaseNotice` already carries, for the same reason.
  ///
  /// IT REPOPULATES TEXT FIELDS AND NOT SELECTS, and that is a limitation of
  /// `SelectField` rather than of this shape: React applies a `<select>`'s
  /// `defaultValue` only at MOUNT, so handing back a changed one after the
  /// reset does nothing. Measured, not assumed - e2e/accommodations.spec.ts
  /// asserts the surviving text. The outcome select is left visibly empty
  /// and `required`, so the retry is obvious rather than silent, and the
  /// expensive thing to lose (the written determination) is kept.
  values?: { outcome?: string; determinationText?: string; subjectDescription?: string }
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/// The intake Task type. One string, used by the create and the completion
/// so a typo cannot leave a task nobody closes.
const TASK_TYPE = 'accommodation.respond'

async function leaseForWrite(leaseId: string) {
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      property: { select: { id: true, legalEntityId: true, timezone: true, addressLine1: true } },
    },
  })
  if (!lease) return null
  const actor = await requirePermission('lease.write', propertyResource(lease.property))
  return { lease, actor }
}

async function archive(params: {
  file: File
  propertyId: string
  leaseId: string
  requestId: string
  staffId: string
}): Promise<void> {
  const buffer = Buffer.from(await params.file.arrayBuffer())
  const contentType = params.file.type || 'application/octet-stream'
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const capturedAt = await extractCapturedAt(buffer, contentType)
  const storageKey = generateStorageKey(params.propertyId, params.file.name)
  await storage.put(storageKey, buffer, contentType)

  await prisma.document.create({
    data: {
      propertyId: params.propertyId,
      leaseId: params.leaseId,
      accommodationRequestId: params.requestId,
      // OTHER, not a new document type. A supporting letter for an
      // accommodation is whatever the requester sent - a note from a
      // physician, a photograph of a training certificate - and inventing a
      // `MEDICAL_RECORD` type would create a category this product then has
      // to have a retention rule and an access policy for. It hangs off the
      // request, which is the thing that governs it.
      type: 'OTHER',
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
 * Log a request as received.
 *
 * ==========================================================================
 * THE CLOCK STARTS HERE, AND THAT IS WHY THIS EXISTS AT ALL.
 *
 * The commonest fair-housing failure on this path is not a wrong decision.
 * It is a request that arrived by text message, sat in somebody's phone, and
 * was answered five weeks later or never - by which point silence has been
 * read as a denial and there is nothing on file to show when it was asked
 * for. So intake is its own action, it is audited, and it raises a Task.
 * ==========================================================================
 */
export async function receiveAccommodationRequest(
  leaseId: string,
  _previous: AccommodationFormState,
  formData: FormData,
): Promise<AccommodationFormState> {
  const found = await leaseForWrite(leaseId)
  if (!found) return { error: 'That tenancy no longer exists.' }
  const { lease, actor } = found

  const kind = str(formData, 'kind')
  const requestText = str(formData, 'requestText')
  const tenantId = str(formData, 'tenantId') || null
  const requestedByName = str(formData, 'requestedByName') || null
  const receivedOn = str(formData, 'receivedOn')

  const fieldErrors: Record<string, string> = {}
  if (!isAccommodationKind(kind)) fieldErrors.kind = 'Which kind of accommodation is this?'
  if (requestText.length < 10) {
    fieldErrors.requestText = 'Record what was actually asked for, in their words where you have them.'
  }
  if (!receivedOn) fieldErrors.receivedOn = 'When did it arrive?'

  const today = businessDate(new Date(), lease.property.timezone)
  if (receivedOn && receivedOn > today) {
    fieldErrors.receivedOn = 'A request cannot be recorded as arriving in the future.'
  }
  if (!tenantId && !requestedByName) {
    fieldErrors.requestedByName = 'Who asked? Pick a tenant, or type the name.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  const request = await prisma.accommodationRequest.create({
    data: {
      propertyId: lease.propertyId,
      leaseId,
      tenantId,
      requestedByName,
      kind: kind as 'SERVICE_ANIMAL',
      requestText,
      receivedOn: businessDateToUtc(receivedOn),
      disabilityObservable: formData.get('disabilityObservable') === 'on',
      needObservable: formData.get('needObservable') === 'on',
    },
  })

  const file = formData.get('support')
  if (file instanceof File && file.size > 0) {
    await archive({
      file,
      propertyId: lease.propertyId,
      leaseId,
      requestId: request.id,
      staffId: actor.id,
    })
  }

  await audit({
    action: 'accommodation.received',
    entityType: 'Lease',
    entityId: leaseId,
    propertyId: lease.propertyId,
    after: {
      requestId: request.id,
      kind,
      receivedOn,
      tenantId,
      requestedByName,
      disabilityObservable: request.disabilityObservable,
      needObservable: request.needObservable,
    },
  })

  // D-9's one queue. URGENT, because the deadline is ten days and the
  // failure mode is nobody looking - not because anything is on fire.
  await createTask(prisma, {
    propertyId: lease.propertyId,
    type: TASK_TYPE,
    subjectType: 'Lease',
    subjectId: request.id,
    businessDate: receivedOn,
    priority: 'URGENT',
    assigneeStaffId: null,
    title: `Respond to an assistance-animal request — ${lease.property.addressLine1}`,
  })

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Request logged. The ten-day response clock starts from the date it arrived.' }
}

/**
 * Record that documentation was requested — refusing where it may not
 * lawfully be asked for.
 *
 * A HARD REFUSAL, not a warning. Asking a service-animal handler for a
 * letter, or asking anyone about an obvious disability, is not a judgement
 * call somebody might have good reason to make anyway — the request itself
 * is the violation, so there is nothing to override with. Same posture as
 * R-069's move-in funds gate and R-084's access-code block.
 */
export async function requestDocumentation(
  _previous: AccommodationFormState,
  formData: FormData,
): Promise<AccommodationFormState> {
  // The id comes from the form, NOT from a bound argument. This panel
  // renders one form per open request, and a `(id) => action` factory handed
  // to a client component is a plain function with no identity the client
  // can call back to (CLAUDE.md's Server→Client rule) - it typechecks and
  // 500s in the browser. A hidden field needs no binding at all.
  const requestId = str(formData, 'requestId')
  if (!requestId) return { error: 'No request named.' }

  const request = await prisma.accommodationRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      leaseId: true,
      propertyId: true,
      status: true,
      kind: true,
      disabilityObservable: true,
      needObservable: true,
      lease: { select: { property: { select: { id: true, legalEntityId: true, timezone: true } } } },
    },
  })
  if (!request) return { error: 'That request no longer exists.' }

  await requirePermission('lease.write', propertyResource(request.lease.property))

  if (request.status !== 'RECEIVED') {
    return { error: 'Documentation can only be requested on a request that is still open.' }
  }

  const decision = documentationRequestable({
    kind: request.kind as 'SERVICE_ANIMAL',
    disabilityObservable: request.disabilityObservable,
    needObservable: request.needObservable,
  })
  if (!decision.requestable) {
    return { error: DOCUMENTATION_REFUSAL_MESSAGES[decision.refusal!] }
  }

  const note = str(formData, 'note')
  const today = businessDate(new Date(), request.lease.property.timezone)

  await prisma.accommodationRequest.update({
    where: { id: requestId },
    data: { status: 'INFO_REQUESTED', infoRequestedOn: businessDateToUtc(today) },
  })

  await audit({
    action: 'accommodation.info_requested',
    entityType: 'Lease',
    entityId: request.leaseId,
    propertyId: request.propertyId,
    after: {
      requestId,
      requestedOn: today,
      note: note || null,
      // The two observations that made the request lawful, snapshotted with
      // it — a complaint asks whether we were ENTITLED to ask, and that
      // turns on what was assessed at the time.
      disabilityObservable: request.disabilityObservable,
      needObservable: request.needObservable,
    },
  })

  revalidatePath(`/leases/${request.leaseId}`)
  return {
    notice:
      'Recorded. The response clock keeps running — asking for documentation does not pause it.',
  }
}

/**
 * The written determination.
 *
 * Approving does two things beyond stamping a status: it records WHICH
 * animal, and from that moment `petMoneyAllowed` refuses pet rent, a pet fee
 * and a pet deposit on this tenancy.
 */
export async function decideAccommodationRequest(
  _previous: AccommodationFormState,
  formData: FormData,
): Promise<AccommodationFormState> {
  // From the form, for the same reason `requestDocumentation` reads it there.
  const requestId = str(formData, 'requestId')
  if (!requestId) return { error: 'No request named.' }

  const request = await prisma.accommodationRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      leaseId: true,
      propertyId: true,
      status: true,
      // R-088: the determination's wording depends on the kind — "which
      // animal" against an animal, "what exactly was agreed" against a policy
      // exception.
      kind: true,
      receivedOn: true,
      tenantId: true,
      tenant: { select: { id: true, firstName: true, email: true, phone: true } },
      lease: {
        select: {
          property: {
            select: { id: true, legalEntityId: true, timezone: true, addressLine1: true },
          },
        },
      },
    },
  })
  if (!request) return { error: 'That request no longer exists.' }

  const actor = await requirePermission('lease.write', propertyResource(request.lease.property))

  if (request.status === 'APPROVED' || request.status === 'DENIED') {
    return {
      error:
        'This request has already been decided. A changed decision is a new request, so the original determination stays on the record.',
    }
  }

  const outcome = str(formData, 'outcome')
  const determinationText = str(formData, 'determinationText')
  const subjectDescription = str(formData, 'subjectDescription')
  const values = { outcome, determinationText, subjectDescription }

  if (outcome !== 'APPROVED' && outcome !== 'DENIED') {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { outcome: 'Approve or deny?' },
      values,
    }
  }

  const violations = validateDetermination({
    outcome,
    determinationText,
    subjectDescription,
    kind: request.kind,
  })
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
      values,
    }
  }

  const zone = request.lease.property.timezone
  const today = businessDate(new Date(), zone)

  await prisma.$transaction(async (tx) => {
    await tx.accommodationRequest.update({
      where: { id: requestId },
      data: {
        status: outcome,
        decidedOn: businessDateToUtc(today),
        decidedByStaffId: actor.id,
        determinationText,
        // Only on an approval - the database CHECK requires it there and a
        // denial has nothing approved to name.
        ...(outcome === 'APPROVED' ? { subjectDescription } : {}),
      },
    })
    await audit(
      {
        action: 'accommodation.decided',
        entityType: 'Lease',
        entityId: request.leaseId,
        propertyId: request.propertyId,
        reason: determinationText,
        after: {
          requestId,
          outcome,
          decidedOn: today,
          subjectDescription: outcome === 'APPROVED' ? subjectDescription : null,
        },
      },
      tx,
    )
  })

  // Close the intake Task. Outside the decision transaction on purpose: a
  // queue row failing to close must not roll back a fair-housing
  // determination that has already been written and audited.
  await prisma.task
    .updateMany({
      where: { type: TASK_TYPE, subjectId: requestId, status: { not: 'DONE' } },
      data: { status: 'DONE', completedAt: new Date(), completedByStaffId: actor.id },
    })
    .catch((error) => {
      console.error(`[accommodations] could not close the task for ${requestId}`, error)
    })

  // Tell the requester, through the engine (R-030), never by hand.
  if (request.tenant) {
    try {
      const outcomes = await notify({
        category: 'legal_notice',
        templateKey: 'accommodation.determination',
        recipient: {
          type: 'TENANT',
          id: request.tenant.id,
          email: request.tenant.email,
          phone: request.tenant.phone,
        },
        context: {
          tenantName: request.tenant.firstName,
          addressLine1: request.lease.property.addressLine1,
          approved: outcome === 'APPROVED',
          determinationText,
        },
        propertyId: request.propertyId,
        idempotencyKey: `accommodation-decision:${requestId}`,
      })
      await dispatchPendingNotifications(new Date(), 100, {
        deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
      })
    } catch (error) {
      console.error(`[accommodations] could not notify the requester for ${requestId}`, error)
    }
  }

  revalidatePath(`/leases/${request.leaseId}`)
  return {
    notice:
      outcome === 'APPROVED'
        ? 'Approved and recorded. Pet rent, pet fees and pet deposits are now refused on this tenancy.'
        : 'Denied, and the written basis is on the record.',
  }
}
