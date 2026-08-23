'use server'

import { createHash } from 'node:crypto'
import {
  DISPOSAL_REFUSAL_MESSAGES,
  disposalReadiness,
  isAbandonmentOutcome,
  isContactMethod,
  isContactOutcome,
} from '@rental/core/abandonment'
import { entryDecision, entryNoticeText } from '@rental/core/entry'
import { businessDate, businessDateToUtc, wallClockToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { extractCapturedAt } from '@/lib/documents/exif.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { getAbandonmentCase } from '@/lib/abandonment/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Writes for abandonment case files (RISK-01, R-087).
//
// NOTHING HERE DECLARES A UNIT ABANDONED. Every action records something a
// human did — an attempt, an entry, an inventory — and the one thing the
// product refuses is disposing of somebody's property before the storage
// clock has run. See packages/core/abandonment for why that is the only
// refusal, and why it is also the only place an unconfigured jurisdiction
// rule blocks rather than warns.
//
// `eviction.manage`, not `lease.write`. This path ends in entering somebody's
// home and moving their possessions; it is the same class of act as opening
// an eviction and it belongs behind the same permission, which R-083 created
// precisely so leasing and notice-serving could be handed out without it.

export interface AbandonmentFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

async function caseForWrite(caseId: string) {
  const actor = await requirePermission('eviction.manage')
  const scope = await currentScope(actor)
  const found = await getAbandonmentCase(caseId, scope)
  if (!found) return null
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: found.propertyId },
    select: { id: true, legalEntityId: true },
  })
  await requirePermission('eviction.manage', propertyResource(property))
  return { found, actor }
}

export async function openAbandonmentCase(
  leaseId: string,
  _previous: AbandonmentFormState,
  formData: FormData,
): Promise<AbandonmentFormState> {
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

  const actor = await requirePermission('eviction.manage', propertyResource(lease.property))

  if (lease.status !== 'ACTIVE' && lease.status !== 'MONTH_TO_MONTH') {
    return { error: 'Only a running tenancy can go dark. This one has already ended.' }
  }

  const open = await prisma.abandonmentCase.findFirst({
    where: { leaseId, status: { not: 'CLOSED' } },
    select: { id: true },
  })
  if (open) {
    return { error: 'This tenancy already has an open abandonment case.' }
  }

  const reason = str(formData, 'reason')
  if (reason.length < 10) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: {
        reason:
          'Why do you think they have gone? This is the first question asked afterwards, and the answer has to have been written down before anybody entered.',
      },
    }
  }

  const lastContactOn = str(formData, 'lastContactOn') || null
  const today = businessDate(new Date(), lease.property.timezone)
  if (lastContactOn && lastContactOn > today) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { lastContactOn: 'That date is in the future.' },
    }
  }

  const created = await prisma.abandonmentCase.create({
    data: {
      propertyId: lease.propertyId,
      unitId: lease.unitId,
      leaseId,
      openedByStaffId: actor.id,
      lastContactOn: lastContactOn ? businessDateToUtc(lastContactOn) : null,
    },
  })

  await audit({
    action: 'abandonment.case_opened',
    entityType: 'AbandonmentCase',
    entityId: created.id,
    propertyId: lease.propertyId,
    reason,
    after: { leaseId, lastContactOn },
  })

  revalidatePath(`/leases/${leaseId}`)
  revalidatePath('/abandonment')
  redirect(`/abandonment/${created.id}`)
}

export async function logContactAttempt(
  _previous: AbandonmentFormState,
  formData: FormData,
): Promise<AbandonmentFormState> {
  // From the form, not a bound argument — see lib/accommodations/actions.ts
  // for why a `(id) => action` factory cannot cross to a client component.
  const caseId = str(formData, 'caseId')
  if (!caseId) return { error: 'No case named.' }

  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found, actor } = context

  if (found.status === 'CLOSED') return { error: 'This case is closed.' }

  const method = str(formData, 'method')
  const outcome = str(formData, 'outcome')
  const attemptedOn = str(formData, 'attemptedOn')

  const fieldErrors: Record<string, string> = {}
  if (!isContactMethod(method)) fieldErrors.method = 'How did you try?'
  if (!isContactOutcome(outcome)) fieldErrors.outcome = 'What happened?'
  if (!attemptedOn) fieldErrors.attemptedOn = 'When?'

  const today = businessDate(new Date(), found.timezone)
  if (attemptedOn && attemptedOn > today) {
    fieldErrors.attemptedOn = 'An attempt cannot be recorded in the future.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  const attempt = await prisma.abandonmentContactAttempt.create({
    data: {
      caseId,
      method: method as 'PHONE_CALL',
      outcome: outcome as 'NO_ANSWER',
      attemptedOn: businessDateToUtc(attemptedOn),
      note: str(formData, 'note') || null,
      recordedByStaffId: actor.id,
    },
  })

  await audit({
    action: 'abandonment.contact_attempted',
    entityType: 'AbandonmentCase',
    entityId: caseId,
    propertyId: found.propertyId,
    after: { attemptId: attempt.id, method, outcome, attemptedOn, note: attempt.note },
  })

  revalidatePath(`/abandonment/${caseId}`)
  return {
    notice:
      outcome === 'REACHED'
        ? 'Recorded. Somebody answered — this tenancy is not abandoned, whatever else is true.'
        : 'Attempt recorded.',
  }
}

/**
 * Record the welfare-check entry.
 *
 * ==========================================================================
 * THE ENTRY IS JUDGED BY THE SAME MACHINERY AS A MAINTENANCE VISIT.
 *
 * `entryDecision` (R-027, MAINT-05) already knows how to weigh notice hours,
 * emergency and tenant permission against a jurisdiction rule, and a welfare
 * check is not a special kind of entry in any statute — it is an entry, and
 * the same notice law applies. Reusing it means a state whose entry rule
 * changes changes here too, with no second copy to forget.
 *
 * It WARNS and requires an override rather than blocking, exactly as R-027
 * does: a landlord who believes somebody may be dead inside does not wait
 * twenty-four hours, and a product that made that impossible would be
 * teaching people to work around it. What it will not allow is doing it
 * without saying why.
 * ==========================================================================
 */
export async function recordEntry(
  _previous: AbandonmentFormState,
  formData: FormData,
): Promise<AbandonmentFormState> {
  const caseId = str(formData, 'caseId')
  if (!caseId) return { error: 'No case named.' }

  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found, actor } = context

  if (found.status === 'CLOSED') return { error: 'This case is closed.' }
  if (found.enteredAt) return { error: 'An entry is already recorded on this case.' }

  const enteredAtLocal = str(formData, 'enteredAt')
  const findings = str(formData, 'entryFindings')
  const noticeServedAtLocal = str(formData, 'noticeServedAt')
  const isEmergency = formData.get('isEmergency') === 'on'
  const overrideReason = str(formData, 'overrideReason')

  const fieldErrors: Record<string, string> = {}
  if (!enteredAtLocal) fieldErrors.enteredAt = 'When did you go in?'
  if (findings.length < 10) {
    fieldErrors.entryFindings =
      'What did you find? Post piled at the door, an empty fridge, furniture gone — this is the paragraph a court reads closely.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  // The PROPERTY's clock, not the server's — a `datetime-local` carries no
  // offset, and R-027 shipped an entry notice stating hours nobody intended
  // by getting exactly this wrong.
  const enteredAt = wallClockToUtc(enteredAtLocal, found.timezone)
  const noticeServedAt = noticeServedAtLocal
    ? wallClockToUtc(noticeServedAtLocal, found.timezone)
    : null

  const rule = await rulesFor(
    { state: found.state, county: found.county },
    enteredAt,
  ).catch(() => null)

  const decision = entryDecision({
    scheduledStart: enteredAt,
    noticeServedAt,
    entryNoticeHours: rule?.entryNoticeHours ?? null,
    isEmergency,
    tenantPermissionGrantedAt: null,
  })

  if (!decision.permitted && !overrideReason) {
    return {
      error: `This entry is ${decision.shortfallHours} hour${decision.shortfallHours === 1 ? '' : 's'} inside the ${decision.requiredHours}-hour notice period for ${found.state}.`,
      fieldErrors: {
        overrideReason:
          'Say why you went in anyway. A welfare concern is a lawful reason in most places — an unexplained entry is what turns this into a self-help eviction.',
      },
    }
  }

  // The notice itself, when one was served. Generated from the same core
  // text a maintenance entry uses — same law, same artifact.
  let noticeId: string | null = null
  if (noticeServedAt) {
    const notice = await prisma.notice.create({
      data: {
        propertyId: found.propertyId,
        leaseId: found.leaseId,
        type: 'ENTRY_NOTICE',
        addressOfRecord: `${found.propertyName} — ${found.unitName}`,
        bodyText: entryNoticeText({
          tenantName: found.tenantNames[0] ?? 'Resident',
          addressLine1: found.propertyName,
          unitName: found.unitName,
          scheduledStart: enteredAt,
          scheduledEnd: enteredAt,
          reason: 'Welfare check — we have been unable to reach you.',
          timezone: found.timezone,
          entryNoticeHours: rule?.entryNoticeHours ?? null,
        }),
        serviceMethod: 'POSTED_WITH_PHOTO',
        servedAt: noticeServedAt,
        servedByStaffId: actor.id,
        jurisdictionRuleId: rule?.id ?? null,
      },
    })
    noticeId = notice.id
  }

  await prisma.abandonmentCase.update({
    where: { id: caseId },
    data: {
      status: 'ENTERED',
      enteredAt,
      entryFindings: findings,
      entryNoticeId: noticeId,
    },
  })

  const file = formData.get('photo')
  if (file instanceof File && file.size > 0) {
    await archive({ file, caseId, propertyId: found.propertyId, staffId: actor.id })
  }

  await audit({
    action: 'abandonment.entered',
    entityType: 'AbandonmentCase',
    entityId: caseId,
    propertyId: found.propertyId,
    // The BASIS, snapshotted. Whether the entry was lawful is the whole of
    // an unlawful-eviction defence, and it must not depend on recomputing a
    // jurisdiction rule that may since have been re-versioned (D-4).
    after: {
      enteredAt: enteredAt.toISOString(),
      basis: decision.basis,
      permitted: decision.permitted,
      requiredHours: decision.requiredHours ?? null,
      shortfallHours: decision.shortfallHours ?? null,
      jurisdictionRuleId: rule?.id ?? null,
      entryNoticeId: noticeId,
      overrideReason: overrideReason || null,
    },
  })

  revalidatePath(`/abandonment/${caseId}`)
  return { notice: 'Entry recorded.' }
}

async function archive(params: {
  file: File
  caseId: string
  propertyId: string
  staffId: string
}): Promise<void> {
  const buffer = Buffer.from(await params.file.arrayBuffer())
  const contentType = params.file.type || 'application/octet-stream'
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  // The photo's own timestamp is the evidence — a picture of an empty room
  // proves nothing without when it was taken. Same call R-051 makes for a
  // posted notice.
  const capturedAt = await extractCapturedAt(buffer, contentType)
  const storageKey = generateStorageKey(params.propertyId, params.file.name)
  await storage.put(storageKey, buffer, contentType)

  await prisma.document.create({
    data: {
      propertyId: params.propertyId,
      abandonmentCaseId: params.caseId,
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

/** Inventory and secure the belongings — the moment the storage clock starts. */
export async function holdBelongings(
  _previous: AbandonmentFormState,
  formData: FormData,
): Promise<AbandonmentFormState> {
  const caseId = str(formData, 'caseId')
  if (!caseId) return { error: 'No case named.' }

  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found, actor } = context

  if (found.status === 'CLOSED') return { error: 'This case is closed.' }
  if (!found.enteredAt) {
    return { error: 'Record the entry and what was found before recording an inventory.' }
  }

  const inventory = str(formData, 'belongingsInventory')
  const heldFrom = str(formData, 'belongingsHeldFrom')

  const fieldErrors: Record<string, string> = {}
  if (inventory.length < 10) {
    fieldErrors.belongingsInventory =
      'List what is being held. "Their things" is not an inventory, and the inventory is what answers a conversion claim.'
  }
  if (!heldFrom) {
    fieldErrors.belongingsHeldFrom = 'The day the property was secured — the clock runs from it.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  await prisma.abandonmentCase.update({
    where: { id: caseId },
    data: {
      status: 'BELONGINGS_HELD',
      belongingsInventory: inventory,
      belongingsHeldFrom: businessDateToUtc(heldFrom),
      belongingsNoticeSentOn: str(formData, 'belongingsNoticeSentOn')
        ? businessDateToUtc(str(formData, 'belongingsNoticeSentOn'))
        : null,
    },
  })

  const file = formData.get('photo')
  if (file instanceof File && file.size > 0) {
    await archive({ file, caseId, propertyId: found.propertyId, staffId: actor.id })
  }

  await audit({
    action: 'abandonment.belongings_held',
    entityType: 'AbandonmentCase',
    entityId: caseId,
    propertyId: found.propertyId,
    after: { heldFrom, inventory },
  })

  revalidatePath(`/abandonment/${caseId}`)
  return { notice: 'Inventory recorded. The storage clock runs from the date you gave.' }
}

/**
 * Dispose of the belongings.
 *
 * ==========================================================================
 * THE ONE HARD REFUSAL IN THIS WORKFLOW.
 *
 * Everything else here records what a human decided. This one is checked
 * against the statutory clock and refused if it has not run — including when
 * this product does not KNOW the state's period, which is the single place in
 * the codebase where an unconfigured jurisdiction rule blocks rather than
 * warns. `disposalReadiness`'s own header sets out why: every other step can
 * be apologised for or re-served, and somebody's photographs in a skip cannot.
 * ==========================================================================
 */
export async function disposeBelongings(
  _previous: AbandonmentFormState,
  formData: FormData,
): Promise<AbandonmentFormState> {
  const caseId = str(formData, 'caseId')
  if (!caseId) return { error: 'No case named.' }

  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found } = context

  if (found.belongingsDisposedAt) return { error: 'Already recorded as disposed of.' }
  if (!found.belongingsHeldFrom) {
    return { error: 'Nothing is recorded as held on this case.' }
  }

  const rule = await rulesFor({ state: found.state, county: found.county }, new Date()).catch(
    () => null,
  )
  const today = businessDate(new Date(), found.timezone)

  const decision = disposalReadiness({
    heldFrom: found.belongingsHeldFrom,
    storageDays: rule?.belongingsStorageDays ?? null,
    noticeDays: rule?.belongingsNoticeDays ?? null,
    noticeSentOn: found.belongingsNoticeSentOn,
    today,
  })
  if (!decision.allowed) {
    return { error: DISPOSAL_REFUSAL_MESSAGES[decision.refusal!] }
  }

  const note = str(formData, 'note')
  if (note.length < 5) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { note: 'Say what was done with it — sold, stored off site, discarded.' },
    }
  }

  await prisma.abandonmentCase.update({
    where: { id: caseId },
    data: { belongingsDisposedAt: new Date() },
  })

  await audit({
    action: 'abandonment.belongings_disposed',
    entityType: 'AbandonmentCase',
    entityId: caseId,
    propertyId: found.propertyId,
    reason: note,
    // The clock that permitted it, snapshotted — so "on what basis was this
    // lawful" never depends on recomputing a rule that has since changed.
    after: {
      heldFrom: found.belongingsHeldFrom,
      storageDays: rule?.belongingsStorageDays ?? null,
      noticeDays: rule?.belongingsNoticeDays ?? null,
      noticeSentOn: found.belongingsNoticeSentOn,
      earliestLawfulOn: decision.earliestOn ?? null,
      jurisdictionRuleId: rule?.id ?? null,
    },
  })

  revalidatePath(`/abandonment/${caseId}`)
  return { notice: 'Recorded.' }
}

export async function closeAbandonmentCase(
  _previous: AbandonmentFormState,
  formData: FormData,
): Promise<AbandonmentFormState> {
  const caseId = str(formData, 'caseId')
  if (!caseId) return { error: 'No case named.' }

  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found } = context

  if (found.status === 'CLOSED') return { error: 'This case is already closed.' }

  const outcome = str(formData, 'outcome')
  const outcomeNote = str(formData, 'outcomeNote')

  const fieldErrors: Record<string, string> = {}
  if (!isAbandonmentOutcome(outcome)) fieldErrors.outcome = 'How did this end?'
  if (outcomeNote.length < 10) {
    fieldErrors.outcomeNote = 'What happened? Somebody will ask a year from now.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  await prisma.abandonmentCase.update({
    where: { id: caseId },
    data: {
      status: 'CLOSED',
      outcome: outcome as 'TENANT_RETURNED',
      outcomeNote,
      closedAt: new Date(),
    },
  })

  await audit({
    action: 'abandonment.case_closed',
    entityType: 'AbandonmentCase',
    entityId: caseId,
    propertyId: found.propertyId,
    reason: outcomeNote,
    after: { outcome },
  })

  revalidatePath(`/abandonment/${caseId}`)
  revalidatePath('/abandonment')
  return { notice: 'Case closed.' }
}
