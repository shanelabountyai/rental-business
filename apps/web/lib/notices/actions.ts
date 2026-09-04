'use server'

import { createHash } from 'node:crypto'
import { CURE_NOTICE_TYPES } from '@rental/core/evictions'
import { NOTICE_SERVICE_METHODS, servicePermitted } from '@rental/core/notices'
import type { NoticeServiceMethodName } from '@rental/core/notices'
import { businessDate, wallClockToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { actorCan, propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { applyPaymentHold } from '@/lib/payments/legal-hold.ts'
import { extractCapturedAt } from '@/lib/documents/exif.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import { renderNoticePdf } from './pdf.ts'

// Writes for notice service and its proof (COMM-02, R-051).
//
// ==========================================================================
// GENERATING AND SERVING ARE SEPARATE ACTS, AND THE PRODUCT NOW SAYS SO.
//
// Before this item the only two notice writers set `servedAt` in the same
// statement that created the row - which was fine for an entry notice
// delivered to the portal in the same breath, and is wrong for every notice
// somebody has to physically take somewhere. A notice to vacate is drafted at
// a desk, printed, driven to the property, taped to a door, photographed, and
// then also mailed. That is one artifact and two or more service events, on
// different days, each with its own proof.
//
// So: `generateNoticePdf` produces and archives the artifact.
// `recordNoticeService` records one service event against it, and may be
// called more than once. Neither implies the other.
// ==========================================================================

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

const NOTICE_INCLUDE = {
  property: {
    select: { id: true, name: true, timezone: true, state: true, county: true, legalEntityId: true, active: true, addressLine1: true },
  },
  lease: {
    select: {
      id: true,
      unit: { select: { id: true, name: true } },
      leaseTenants: {
        orderBy: { isPrimary: 'desc' as const },
        select: { tenant: { select: { id: true, firstName: true, lastName: true } } },
      },
      // R-165: the demand ladder is addressed to a guarantor alongside the
      // tenant - only ones still attached to the lease (a released guarantor
      // is no longer a party to it).
      guarantors: {
        where: { active: true },
        select: { firstName: true, lastName: true },
      },
    },
  },
  /// The "or" half of Notice's either/or (R-061) - see that column's own
  /// schema comment.
  applicant: { select: { id: true, firstName: true, lastName: true } },
} as const

/**
 * Renders the notice to PDF and archives it as a Document.
 *
 * Idempotent: a notice that already has a document returns it rather than
 * minting a second. That is not a convenience - re-rendering after service
 * would produce a DIFFERENT file for the same served notice, and then the
 * question "which of these did the tenant actually receive" has no answer.
 */
export async function generateNoticePdf(noticeId: string): Promise<FormState> {
  const notice = await prisma.notice.findUniqueOrThrow({
    where: { id: noticeId },
    include: NOTICE_INCLUDE,
  })
  const actor = await requirePermission('notice.send', propertyResource(notice.property))

  if (notice.documentId) {
    return { notice: 'This notice already has an archived PDF.' }
  }
  if (!notice.bodyText) {
    return { error: 'This notice has no body text to render.' }
  }

  const rule = await rulesFor(
    { state: notice.property.state, county: notice.property.county },
    new Date(),
  ).catch(() => null)

  // EITHER a lease or an applicant, never both (the CHECK constraint, R-061)
  // - `notice.lease`/`notice.applicant` are the two names on the letter's
  // own "To:" line, whichever one this notice actually has.
  const unitName = notice.lease?.unit.name ?? null
  const recipientNames = notice.lease
    ? [
        ...notice.lease.leaseTenants.map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`),
        ...notice.lease.guarantors.map((g) => `${g.firstName} ${g.lastName} (guarantor)`),
      ]
    : notice.applicant
      ? [`${notice.applicant.firstName} ${notice.applicant.lastName}`]
      : []

  const bytes = await renderNoticePdf({
    noticeType: notice.type,
    addressOfRecord: notice.addressOfRecord,
    propertyName: notice.property.name,
    unitName,
    tenantNames: recipientNames,
    bodyText: notice.bodyText,
    // The PROPERTY's calendar day, not the server's (D-3). A notice dated by
    // a machine in another timezone is dated wrong on the day it matters.
    generatedOn: businessDate(notice.generatedAt, notice.property.timezone),
    citation: rule?.citation ?? null,
  })

  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `${notice.type.toLowerCase()}-${businessDate(notice.generatedAt, notice.property.timezone)}.pdf`
  const storageKey = generateStorageKey(notice.propertyId, fileName)
  // Stored before the row, same order and same reasoning as uploadDocument:
  // an orphaned object costs disk, an orphaned row costs a document nobody
  // can open.
  await storage.put(storageKey, buffer, 'application/pdf')

  await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId: notice.propertyId,
        leaseId: notice.leaseId,
        applicantId: notice.applicantId,
        // The TENANT link is what puts it in their /portal/papers list with
        // no further work - `listTenantDocuments` already maps NOTICE to
        // "A notice". An applicant has no portal to put anything in.
        tenantId: notice.lease?.leaseTenants[0]?.tenant.id ?? null,
        type: 'NOTICE',
        fileName,
        contentType: 'application/pdf',
        sizeBytes: buffer.byteLength,
        storageKey,
        sha256,
        uploadedByStaffId: actor.id,
      },
    })
    await tx.notice.update({ where: { id: notice.id }, data: { documentId: document.id } })
    await audit(
      {
        action: 'notice.generated',
        entityType: 'Notice',
        entityId: notice.id,
        propertyId: notice.propertyId,
        after: { documentId: document.id, sha256, sizeBytes: buffer.byteLength },
      },
      tx,
    )
  })

  revalidatePath(`/notices/${noticeId}`)
  return { notice: 'Notice PDF generated and archived.' }
}

/**
 * The `<form action>` shape for `generateNoticePdf`.
 *
 * A form action is handed FormData and must resolve to void, while the
 * function above returns a FormState worth asserting on in a test. Keeping
 * both is cheaper than contorting either: the page binds this one, and the
 * tests call the real one.
 */
export async function generateNoticePdfAction(
  noticeId: string,
  _formData: FormData,
): Promise<void> {
  await generateNoticePdf(noticeId)
}

/**
 * Records ONE service event, with its proof.
 *
 * Callable repeatedly: "posted and mailed" is two calls, and several statutes
 * require exactly that. The database enforces the shape each method promises
 * (a POSTED_WITH_PHOTO row cannot exist without a photograph); this validates
 * the same things first so the operator gets a sentence rather than a
 * constraint violation.
 */
export async function recordNoticeService(
  noticeId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const notice = await prisma.notice.findUniqueOrThrow({
    where: { id: noticeId },
    include: NOTICE_INCLUDE,
  })
  const actor = await requirePermission('notice.send', propertyResource(notice.property))

  const method = str(formData, 'method') as NoticeServiceMethodName
  if (!(NOTICE_SERVICE_METHODS as readonly string[]).includes(method)) {
    return { error: 'Choose how the notice was served.' }
  }

  const servedAtLocal = str(formData, 'servedAt')
  if (!servedAtLocal) {
    return { fieldErrors: { servedAt: 'When was it served?' }, error: 'Fix the highlighted fields.' }
  }
  // A `datetime-local` input submits no timezone, so `Date.parse` would use
  // the SERVER's - UTC on Vercel. R-036b served an entry notice stating hours
  // nobody intended to keep by making exactly this mistake; the helper that
  // fixes it already exists.
  const servedAt = wallClockToUtc(servedAtLocal, notice.property.timezone)
  if (Number.isNaN(servedAt.getTime())) {
    return { fieldErrors: { servedAt: 'Enter a valid date and time.' }, error: 'Fix the highlighted fields.' }
  }
  if (servedAt.getTime() > Date.now() + 60_000) {
    // A minute of slack for clock skew, and no more: service is a thing that
    // has happened, and a record of serving somebody tomorrow is not proof,
    // it is a plan.
    return {
      fieldErrors: { servedAt: 'Service cannot be recorded in the future.' },
      error: 'Fix the highlighted fields.',
    }
  }

  const trackingNumber = str(formData, 'trackingNumber') || null
  const carrier = str(formData, 'carrier') || null
  const note = str(formData, 'note') || null
  const file = formData.get('proof')
  const hasFile = file instanceof File && file.size > 0

  if (method === 'POSTED_WITH_PHOTO' && !hasFile) {
    return {
      fieldErrors: { proof: 'A photo of the posted notice is required.' },
      error: 'Fix the highlighted fields.',
    }
  }
  if (method === 'CERTIFIED_MAIL' && !trackingNumber) {
    return {
      fieldErrors: { trackingNumber: 'Enter the certified-mail article number.' },
      error: 'Fix the highlighted fields.',
    }
  }

  const rule = await rulesFor(
    { state: notice.property.state, county: notice.property.county },
    servedAt,
  ).catch(() => null)
  // Recorded as it stood AT SERVICE, never recomputed later: D-4 says rules
  // apply prospectively and changing one never rewrites what it produced, so
  // a state that legalises door-posting next year must not retroactively make
  // last year's posting look compliant.
  const permitted = servicePermitted(rule, notice.type, method)

  let proofDocumentId: string | null = null
  if (hasFile) {
    const proofFile = file as File
    const buffer = Buffer.from(await proofFile.arrayBuffer())
    const contentType = proofFile.type || 'application/octet-stream'
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    // THE PHOTO'S OWN TIMESTAMP IS THE EVIDENCE for a posted notice - a
    // picture of a door proves nothing without when it was taken. R-012
    // already extracts it; the vendor upload path skips this and is the
    // wrong template to copy here.
    const capturedAt = await extractCapturedAt(buffer, contentType)
    const storageKey = generateStorageKey(notice.propertyId, proofFile.name)
    await storage.put(storageKey, buffer, contentType)

    const document = await prisma.document.create({
      data: {
        propertyId: notice.propertyId,
        leaseId: notice.leaseId,
        applicantId: notice.applicantId,
        type: 'NOTICE_PROOF',
        fileName: proofFile.name,
        contentType,
        sizeBytes: proofFile.size,
        storageKey,
        sha256,
        capturedAt,
        uploadedByStaffId: actor.id,
      },
    })
    proofDocumentId = document.id
  }

  await prisma.$transaction(async (tx) => {
    const delivery = await tx.noticeDelivery.create({
      data: {
        noticeId: notice.id,
        method,
        servedAt,
        servedByStaffId: actor.id,
        proofDocumentId,
        trackingNumber,
        carrier,
        permittedByJurisdiction: permitted,
        jurisdictionRuleId: rule?.id ?? null,
        note,
      },
    })

    // The Notice's own columns carry the FIRST service, for readers written
    // before this item and for list screens that sort on it. Only ever set
    // when empty: a second service event does not rewrite the first.
    if (!notice.servedAt) {
      await tx.notice.update({
        where: { id: notice.id },
        data: {
          serviceMethod: method,
          servedAt,
          servedByStaffId: actor.id,
          proofDocumentId,
          trackingNumber,
        },
      })
    }

    await audit(
      {
        action: 'notice.served',
        entityType: 'Notice',
        entityId: notice.id,
        propertyId: notice.propertyId,
        after: {
          deliveryId: delivery.id,
          method,
          servedAt: servedAt.toISOString(),
          proofDocumentId,
          trackingNumber,
          carrier,
          permittedByJurisdiction: permitted,
          jurisdictionRuleId: rule?.id ?? null,
        },
      },
      tx,
    )
  })

  revalidatePath(`/notices/${noticeId}`)
  revalidatePath('/notices')

  // R-156. Serving a cure-starting notice is the moment the hold matters -
  // the review's own finding: the panel that does the right thing lives on
  // the lease page, at a different moment, driven by memory. The service is
  // ALREADY RECORDED above whatever happens here: a hold that could not be
  // placed must never cost the owner the record of a service that physically
  // happened.
  if (formData.get('placeHold') === 'on') {
    const outcome = await placeServiceHold(notice, formData, actor.id)
    if (!outcome.ok) {
      return {
        error: `Service recorded — but the payment hold is NOT in force: ${outcome.error}`,
      }
    }
    return {
      notice:
        outcome.linksRevoked > 0
          ? `Service recorded, and the payment hold is in force — confirmed with the payment provider. ${outcome.linksRevoked} live pay-now ${outcome.linksRevoked === 1 ? 'link was' : 'links were'} revoked.`
          : 'Service recorded, and the payment hold is in force — confirmed with the payment provider.',
    }
  }

  return { notice: 'Service recorded.' }
}

/// The inline serve-and-hold (R-156). Placing a hold is `ledger.adjust`
/// work whoever's form it rides in - the page only OFFERS the switches to
/// actors who hold it, but a hand-made POST must meet the same bar as the
/// lease page's own panel.
async function placeServiceHold(
  notice: { id: string; type: string; leaseId: string | null; property: { id: string; legalEntityId: string } },
  formData: FormData,
  actorStaffId: string,
): Promise<{ ok: true; linksRevoked: number } | { ok: false; error: string }> {
  if (!notice.leaseId) return { ok: false, error: 'This notice has no lease to hold payments on.' }
  if (!CURE_NOTICE_TYPES.includes(notice.type)) {
    return { ok: false, error: 'Only a cure-starting notice places a hold at service.' }
  }
  if (!(await actorCan('ledger.adjust', propertyResource(notice.property)))) {
    return { ok: false, error: 'Placing a payment hold needs the ledger-adjust permission.' }
  }

  const change = {
    blockOnline: formData.get('holdBlockOnline') === 'on',
    blockPartial: formData.get('holdBlockPartial') === 'on',
    certifiedFundsOnly: formData.get('holdCertifiedFundsOnly') === 'on',
    reason: str(formData, 'holdReason'),
  }
  if (!change.blockOnline && !change.blockPartial && !change.certifiedFundsOnly) {
    // All-off through applyPaymentHold LIFTS a hold - not what a serve
    // screen may ever do by accident. Untick the offer instead.
    return { ok: false, error: 'Every switch is off. Untick the hold instead of placing an empty one.' }
  }

  const payers = await prisma.leasePayer.findMany({
    where: { leaseId: notice.leaseId, active: true },
    select: { id: true },
  })
  if (payers.length === 0) return { ok: false, error: 'No active payer exists on this lease.' }

  // Every active payer, not just the tenant's own: a pay-now link in a
  // roommate's phone collects the same waiver-risk money. Voucher leases
  // would want the housing authority left alone, and there are none (D-136)
  // - the first one re-opens this as a feature, not a bug.
  let linksRevoked = 0
  for (const payer of payers) {
    const result = await applyPaymentHold(payer.id, change, actorStaffId, audit)
    if (!result.ok) return { ok: false, error: result.error }
    linksRevoked += result.linksRevoked
  }
  revalidatePath(`/leases/${notice.leaseId}`)
  revalidatePath('/money')
  return { ok: true, linksRevoked }
}

/**
 * The portal read receipt: the tenant opened a notice served to them there
 * (COMM-02's "portal delivery with read receipt").
 *
 * For PORTAL service this is the ONLY evidence the notice reached anybody, so
 * it is written from the tenant's own authenticated view of the notice and
 * never from a staff screen.
 *
 * Write-once at the database (see the migration's trigger). This checks first
 * anyway so the ordinary second visit is a no-op rather than a caught
 * exception, and swallows a lost race deliberately: two tabs opening the same
 * notice must not 500 the page the tenant is trying to read.
 */
export async function markNoticeRead(noticeId: string, leaseIds: readonly string[]): Promise<void> {
  if (leaseIds.length === 0) return

  const delivery = await prisma.noticeDelivery.findFirst({
    where: {
      noticeId,
      method: 'PORTAL',
      readAt: null,
      notice: { leaseId: { in: [...leaseIds] } },
    },
    select: { id: true, notice: { select: { propertyId: true } } },
  })
  if (!delivery) return

  try {
    await prisma.$transaction(async (tx) => {
      await tx.noticeDelivery.update({
        where: { id: delivery.id },
        data: { readAt: new Date() },
      })
      await audit(
        {
          action: 'notice.read',
          entityType: 'Notice',
          entityId: noticeId,
          propertyId: delivery.notice.propertyId,
          after: { deliveryId: delivery.id },
        },
        tx,
      )
    })
  } catch (error) {
    // The trigger refuses a second write, which is the guarantee working.
    console.error(`[notice] could not record read receipt for ${noticeId}`, error)
  }
}
