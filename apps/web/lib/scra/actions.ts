'use server'

import { createHash } from 'node:crypto'
import { HOLD_DEFINITIONS } from '@rental/core/holds'
import {
  SCRA_BASIS_LABELS,
  SCRA_TERMINATION_REFUSAL_MESSAGES,
  isScraLookupResult,
  isScraTerminationBasis,
  scraTermination,
} from '@rental/core/scra'
import { businessDate, businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { extractCapturedAt } from '@/lib/documents/exif.ts'
import { toDbLookupResult } from '@/lib/scra/queries.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Writes for the SCRA (RISK-12, R-085).
//
// Two actions, and they answer to different halves of the statute: recording
// what a DMDC search said (§3931's affidavit), and ending a tenancy on
// military orders (§3955). Neither decides anything the statute leaves to a
// person - see packages/core/scra's own header.

export interface ScraFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/// Shared by both actions: turn an uploaded file into an archived Document.
/// The same six lines lib/notices/actions.ts writes for a service proof -
/// extracted here rather than imported from there because that one is bound
/// to a Notice's own columns, and copying six lines beats threading a
/// third caller through a function shaped for notices.
async function archive(params: {
  file: File
  propertyId: string
  leaseId: string
  tenantId: string | null
  type: 'MILITARY_ORDERS' | 'SCRA_CERTIFICATE'
  staffId: string
}): Promise<string> {
  const buffer = Buffer.from(await params.file.arrayBuffer())
  const contentType = params.file.type || 'application/octet-stream'
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const capturedAt = await extractCapturedAt(buffer, contentType)
  const storageKey = generateStorageKey(params.propertyId, params.file.name)
  await storage.put(storageKey, buffer, contentType)

  const document = await prisma.document.create({
    data: {
      propertyId: params.propertyId,
      leaseId: params.leaseId,
      tenantId: params.tenantId,
      type: params.type,
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

/**
 * Record one DMDC military-service search.
 *
 * `lease.write`, not `eviction.manage`: the right time to run this is BEFORE
 * an eviction exists, and gating it on the eviction permission would put the
 * cheap preventive act behind the expensive one.
 */
export async function recordScraLookup(
  leaseId: string,
  _previous: ScraFormState,
  formData: FormData,
): Promise<ScraFormState> {
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      property: { select: { id: true, legalEntityId: true, timezone: true } },
    },
  })
  if (!lease) return { error: 'That tenancy no longer exists.' }

  const actor = await requirePermission('lease.write', propertyResource(lease.property))

  const tenantId = str(formData, 'tenantId')
  const rawResult = str(formData, 'result')
  const searchedOn = str(formData, 'searchedOn')
  const evictionCaseId = str(formData, 'evictionCaseId') || null

  const fieldErrors: Record<string, string> = {}
  if (!tenantId) fieldErrors.tenantId = 'Who was searched for?'
  if (!isScraLookupResult(rawResult)) fieldErrors.result = 'What did the certificate say?'
  if (!searchedOn) fieldErrors.searchedOn = 'When was the search run?'

  const today = businessDate(new Date(), lease.property.timezone)
  if (searchedOn && searchedOn > today) {
    // A search is a thing that has happened. A record of searching tomorrow
    // is not evidence, it is a plan — the same line `recordNoticeService`
    // draws about service.
    fieldErrors.searchedOn = 'A search cannot be recorded in the future.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  const result = rawResult as Parameters<typeof toDbLookupResult>[0]
  const dbResult = toDbLookupResult(result)

  const onTenancy = await prisma.leaseTenant.findFirst({
    where: { leaseId, tenantId },
    select: { id: true },
  })
  if (!onTenancy) return { error: 'That person is not on this tenancy.' }

  const startOn = str(formData, 'activeDutyStartOn')
  const endOn = str(formData, 'activeDutyEndOn')
  // The database CHECK refuses duty dates on a non-IN_SERVICE row. Dropping
  // them here rather than erroring: somebody who typed dates and then
  // changed the result should not lose the form, and the dates are
  // meaningless on a negative certificate anyway.
  const dutyDates =
    dbResult === 'IN_SERVICE'
      ? {
          activeDutyStartOn: startOn ? businessDateToUtc(startOn) : null,
          activeDutyEndOn: endOn ? businessDateToUtc(endOn) : null,
        }
      : { activeDutyStartOn: null, activeDutyEndOn: null }

  const file = formData.get('certificate')
  const certificateDocumentId =
    file instanceof File && file.size > 0
      ? await archive({
          file,
          propertyId: lease.propertyId,
          leaseId,
          tenantId,
          type: 'SCRA_CERTIFICATE',
          staffId: actor.id,
        })
      : null

  const lookup = await prisma.scraLookup.create({
    data: {
      leaseId,
      propertyId: lease.propertyId,
      tenantId,
      evictionCaseId,
      result: dbResult,
      searchedOn: businessDateToUtc(searchedOn),
      providerReference: str(formData, 'providerReference') || null,
      notes: str(formData, 'notes') || null,
      certificateDocumentId,
      recordedByStaffId: actor.id,
      ...dutyDates,
    },
  })

  await audit({
    action: 'scra.lookup_recorded',
    entityType: 'Lease',
    entityId: leaseId,
    propertyId: lease.propertyId,
    after: {
      lookupId: lookup.id,
      tenantId,
      result,
      searchedOn,
      providerReference: lookup.providerReference,
      certificateDocumentId,
      evictionCaseId,
    },
  })

  // ==========================================================================
  // A POSITIVE CERTIFICATE PLACES THE HOLD ITSELF (R-084).
  //
  // The one place in this product that places a hold without somebody asking
  // for it, and the justification is specific: every other hold type rests on
  // a judgement (is this balance really disputed, has the estate really
  // opened), while this one rests on a signed federal certificate that has
  // just been read into the record. Leaving it manual would mean the whole of
  // R-084's SCRA protection depended on the person who ran the search
  // remembering to go and switch it on afterwards.
  //
  // The reason written on the hold is better than most typed ones, because it
  // names the document it came from.
  // ==========================================================================
  let holdPlaced = false
  if (dbResult === 'IN_SERVICE') {
    const existing = await prisma.leaseHold.findFirst({
      where: { leaseId, type: 'MILITARY_SCRA', liftedAt: null },
      select: { id: true },
    })
    if (!existing) {
      const reason = `DMDC search on ${searchedOn}${
        lookup.providerReference ? ` (certificate ${lookup.providerReference})` : ''
      } reports active duty service.`
      const hold = await prisma.leaseHold.create({
        data: {
          leaseId,
          propertyId: lease.propertyId,
          type: 'MILITARY_SCRA',
          reason,
          placedByStaffId: actor.id,
        },
      })
      await audit({
        action: 'lease.hold_placed',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        reason,
        after: {
          holdId: hold.id,
          type: 'military_scra',
          effects: HOLD_DEFINITIONS.military_scra.effects,
          // So the trail says this was not somebody clicking a button.
          placedBy: 'scra_lookup',
          lookupId: lookup.id,
        },
      })
      holdPlaced = true
    }
  }

  revalidatePath(`/leases/${leaseId}`)
  if (evictionCaseId) revalidatePath(`/evictions/${evictionCaseId}`)

  return {
    notice: holdPlaced
      ? 'Search recorded, and an SCRA hold was placed on this tenancy.'
      : 'Search recorded.',
  }
}

/**
 * End a tenancy under §3955.
 *
 * ==========================================================================
 * ITS OWN ACTION RATHER THAN A FLAG ON `recordLeaseNotice`, and the reason is
 * that four of that function's six checks are wrong here.
 *
 *   * The state's `noticeToVacateDays` does not apply - §3955 is federal and
 *     preempts it. Running `noticePeriodCheck` would warn a servicemember's
 *     PM that a federal right is "short notice" and demand an override
 *     reason for it.
 *   * Just cause does not apply: the tenant is ending their own tenancy.
 *   * The retaliation check does not apply, for the same reason.
 *   * The effective date is COMPUTED, not typed. It is the one number this
 *     item exists to get right, and a free date field is an invitation to
 *     get it wrong.
 *
 * What it shares with `recordLeaseNotice` is the columns it writes, which is
 * the part worth sharing: an SCRA termination IS a tenant-given notice
 * (R-066), not a second kind of ending with its own entity.
 * ==========================================================================
 */
export async function recordScraTermination(
  leaseId: string,
  _previous: ScraFormState,
  formData: FormData,
): Promise<ScraFormState> {
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      status: true,
      rentDueDay: true,
      noticeGivenAt: true,
      scraTerminationBasis: true,
      property: { select: { id: true, legalEntityId: true, timezone: true } },
    },
  })
  if (!lease) return { error: 'That tenancy no longer exists.' }

  const actor = await requirePermission('lease.write', propertyResource(lease.property))

  if (lease.noticeGivenAt) {
    return {
      error:
        'Notice has already been recorded on this tenancy. Clearing it and starting again is a lease edit, not a second notice.',
    }
  }
  if (lease.status !== 'ACTIVE' && lease.status !== 'MONTH_TO_MONTH') {
    return { error: 'Only a running tenancy can be terminated under §3955.' }
  }

  const basis = str(formData, 'basis')
  const deliveredOn = str(formData, 'deliveredOn')
  const forwardingAddress = str(formData, 'forwardingAddress') || null

  const fieldErrors: Record<string, string> = {}
  if (!isScraTerminationBasis(basis)) fieldErrors.basis = 'Which limb of §3955(b)?'
  if (!deliveredOn) fieldErrors.deliveredOn = 'When were the notice and orders delivered?'

  const today = businessDate(new Date(), lease.property.timezone)
  if (deliveredOn && deliveredOn > today) {
    fieldErrors.deliveredOn = 'Delivery cannot be recorded in the future.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  const file = formData.get('orders')
  const hasOrders = file instanceof File && file.size > 0

  const decision = scraTermination({
    deliveredOn,
    rentDueDay: lease.rentDueDay,
    basis: basis as Parameters<typeof scraTermination>[0]['basis'],
    hasOrdersOnFile: hasOrders,
  })
  if (decision.refusal) {
    return {
      error: SCRA_TERMINATION_REFUSAL_MESSAGES[decision.refusal],
      fieldErrors: { orders: 'Attach the orders.' },
    }
  }

  const ordersDocumentId = await archive({
    file: file as File,
    propertyId: lease.propertyId,
    leaseId,
    tenantId: null,
    type: 'MILITARY_ORDERS',
    staffId: actor.id,
  })

  const dbBasis = basis === 'entered_service' ? 'ENTERED_SERVICE' : 'PCS_OR_DEPLOYMENT'

  await prisma.$transaction(async (tx) => {
    await tx.lease.update({
      where: { id: leaseId },
      data: {
        // A tenant-given notice, because that is what it is (R-066).
        noticeGivenAt: businessDateToUtc(deliveredOn),
        noticeGivenBy: 'TENANT',
        noticeEffectiveOn: businessDateToUtc(decision.effectiveOn),
        noticeForwardingAddress: forwardingAddress,
        scraTerminationBasis: dbBasis,
      },
    })
    await audit(
      {
        action: 'lease.scra_terminated',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        after: {
          basis,
          deliveredOn,
          // The arithmetic, not just its answer: §3955(d)'s "next rent due
          // after delivery, plus 30" is what somebody disputing the date
          // will want to see reconstructed.
          runsFromRentDue: decision.runsFromRentDue,
          effectiveOn: decision.effectiveOn,
          rentDueDay: lease.rentDueDay,
          ordersDocumentId,
        },
      },
      tx,
    )
    // The same `lease.notice_given` every other notice writes, so anything
    // reading the tenancy's notice history sees this one too rather than
    // having to know about a second action.
    await audit(
      {
        action: 'lease.notice_given',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        after: {
          noticeGivenAt: businessDateToUtc(deliveredOn).toISOString(),
          noticeGivenBy: 'TENANT',
          effectiveOn: businessDateToUtc(decision.effectiveOn).toISOString(),
          scraTerminationBasis: basis,
        },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${leaseId}`)
  return {
    notice: `Recorded. Under ${SCRA_BASIS_LABELS[basis as 'entered_service']}, the tenancy ends on ${utcToBusinessDate(
      businessDateToUtc(decision.effectiveOn),
    )} — 30 days after the ${decision.runsFromRentDue} rent due date.`,
  }
}
