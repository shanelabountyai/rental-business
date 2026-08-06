'use server'

import { createHash } from 'node:crypto'
import { openSecret } from '@rental/core/auth'
import {
  type VendorResponseValue,
  validateVendorInvoice,
  validateVendorResponse,
  vendorMayRespond,
  vendorMayUpload,
} from '@rental/core/vendors'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { auditAsVendor } from '@/lib/audit/system.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import { verifyVendorLink } from './link.ts'
import { vendorRejectionMessage } from './messages.ts'

// Everything a vendor can do, all of it through a magic link and none of it
// with an account (D-6, D-16, MAINT-03, R-025).
//
// EVERY function here takes the raw token as its FIRST argument and
// re-verifies it, because there is no session to fall back on: the token is
// the only credential, so a call that forgot to check it would be an
// unauthenticated write. That is why there is no shared "current vendor"
// helper the way staff actions have `requirePermission()` - a helper that
// can be forgotten is worse than a parameter that cannot be.
//
// The audit actor is VENDOR throughout (lib/audit/system.ts's own comment
// explains why that is not SYSTEM).

export interface VendorFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Accept / decline / propose a time (MAINT-03).
 *
 * Answers once and only once - `vendorMayRespond()` refuses a second answer,
 * because staff may already have told the tenant somebody is coming, and a
 * vendor silently flipping accept to decline hours later is how a tenant
 * waits in all afternoon for nobody. Changing their mind is a phone call.
 */
export async function respondToWorkOrder(
  token: string,
  _previous: VendorFormState,
  formData: FormData,
): Promise<VendorFormState> {
  const link = await verifyVendorLink(token)
  if (!link.ok) return { error: vendorRejectionMessage(link.reason) }

  const { workOrder, vendorId } = link
  if (!vendorMayRespond(workOrder.vendorResponse)) {
    return { error: 'You have already answered this one. Call the office to change it.' }
  }

  const input = {
    response: str(formData, 'response'),
    declineReason: str(formData, 'declineReason') || null,
    proposedStart: str(formData, 'proposedStart') || null,
    proposedEnd: str(formData, 'proposedEnd') || null,
  }
  const violations = validateVendorResponse(input)
  if (violations.length > 0) {
    return {
      error: 'A couple of things still need an answer.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }
  const response = input.response as VendorResponseValue

  await prisma.$transaction(async (tx) => {
    await tx.workOrder.update({
      where: { id: workOrder.id },
      data: {
        vendorResponse: response,
        vendorRespondedAt: new Date(),
        vendorDeclineReason: response === 'DECLINED' ? input.declineReason : null,
        proposedStart: response === 'PROPOSED_TIME' ? new Date(input.proposedStart!) : null,
        proposedEnd: response === 'PROPOSED_TIME' ? new Date(input.proposedEnd!) : null,
        // A decline hands the work order back to the PM: the vendor is
        // cleared so it shows as unassigned in the queue, and
        // `fallbackVendorsForTrade()` can exclude whoever just said no.
        // Accepting is NOT scheduling - R-027 owns confirming a window with
        // an entry-notice check, so an accepted job stays ASSIGNED.
        ...(response === 'DECLINED' ? { vendorId: null, status: 'SUBMITTED' as const } : {}),
      },
    })
    await auditAsVendor(
      vendorId,
      {
        action: 'workorder.vendor_responded',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        propertyId: workOrder.propertyId,
        before: { status: workOrder.status, vendorResponse: workOrder.vendorResponse },
        after: {
          vendorResponse: response,
          declineReason: input.declineReason,
          proposedStart: input.proposedStart,
          proposedEnd: input.proposedEnd,
        },
      },
      tx,
    )
  })

  revalidatePath(`/workorders/${workOrder.id}`)
  return { notice: 'Thanks - the office has been told.' }
}

/**
 * Reveals one access code to the vendor, and logs it (PROP-03: "codes are
 * revealed per-work-order only and each reveal is logged").
 *
 * Logged EVERY time, not just the first - the audit entry is the answer to
 * "who could have opened this door on the day of the break-in", and a vendor
 * opening the code once to write it down and again three days later are two
 * separate facts. This is the single most sensitive thing a magic link can
 * do, which is why it is a deliberate action rather than something the page
 * renders on load.
 */
export async function revealCodeForVendor(
  token: string,
  accessCodeId: string,
): Promise<{ code?: string; error?: string }> {
  const link = await verifyVendorLink(token)
  if (!link.ok) return { error: vendorRejectionMessage(link.reason) }

  const { workOrder, vendorId } = link
  // Accepted vendors only. Somebody who has not answered, or who declined,
  // has no business holding a gate code - and this is exactly the case where
  // "the link is still technically live" is not a good enough reason.
  if (!vendorMayUpload(workOrder.vendorResponse)) {
    return { error: 'Accept the job first and the access details will appear here.' }
  }

  const accessCode = await prisma.accessCode.findUnique({ where: { id: accessCodeId } })
  // Scoped to the work order's OWN unit. Without this the vendor could pass
  // any AccessCode id and read a code for a unit they were never sent to.
  if (!accessCode || accessCode.unitId !== workOrder.unitId || accessCode.effectiveTo !== null) {
    return { error: 'That access code is not available for this job.' }
  }

  const code = openSecret(accessCode.sealedCode, 'access-code')
  if (code == null) {
    return { error: 'This code could not be read. Please call the office.' }
  }

  await auditAsVendor(vendorId, {
    action: 'accesscode.revealed',
    entityType: 'AccessCode',
    entityId: accessCode.id,
    propertyId: workOrder.propertyId,
    after: {
      type: accessCode.type,
      version: accessCode.version,
      workOrderId: workOrder.id,
      viaVendorLink: true,
    },
  })

  return { code }
}

/**
 * Completion photos and the invoice (MAINT-03: "upload completion photos and
 * an invoice - even a napkin photo - without an account").
 *
 * One function for both because the difference is a document type and an
 * optional amount, not a different flow. Images only for a completion photo;
 * an invoice may also be a PDF, since half of vendors email a real one and
 * half photograph a receipt.
 */
export async function uploadVendorDocument(
  token: string,
  _previous: VendorFormState,
  formData: FormData,
): Promise<VendorFormState> {
  const link = await verifyVendorLink(token)
  if (!link.ok) return { error: vendorRejectionMessage(link.reason) }

  const { workOrder, vendorId } = link
  if (!vendorMayUpload(workOrder.vendorResponse)) {
    return { error: 'Accept the job first, then you can upload photos and an invoice.' }
  }

  const kind = str(formData, 'kind')
  if (kind !== 'COMPLETION_PHOTO' && kind !== 'INVOICE') {
    return { error: 'Choose whether this is a completion photo or the invoice.' }
  }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose a file to upload.' }
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: 'That file is too large. Please keep it under 15MB.' }
  }
  const isImage = file.type.startsWith('image/')
  if (kind === 'COMPLETION_PHOTO' && !isImage) {
    return { error: 'A completion photo has to be an image.' }
  }
  if (kind === 'INVOICE' && !isImage && file.type !== 'application/pdf') {
    return { error: 'An invoice has to be a photo or a PDF.' }
  }

  const invoiceDollars = str(formData, 'invoiceDollars')
  const invoiceCents = invoiceDollars ? Math.round(Number(invoiceDollars) * 100) : null
  if (kind === 'INVOICE') {
    const violations = validateVendorInvoice({ invoiceCents })
    if (violations.length > 0) {
      return {
        error: 'Check the amount.',
        fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
      }
    }
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const storageKey = generateStorageKey(workOrder.propertyId, file.name)
  await storage.put(storageKey, buffer, file.type)

  await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId: workOrder.propertyId,
        unitId: workOrder.unitId,
        workOrderId: workOrder.id,
        vendorId,
        type: kind,
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        storageKey,
        sha256,
      },
    })
    // The invoice AMOUNT lands on the work order; the file is the evidence
    // beside it. Never overwritten once set - a second invoice upload is a
    // revision the PM reconciles, not something a vendor silently replaces.
    if (kind === 'INVOICE' && invoiceCents != null && workOrder.invoiceCents == null) {
      await tx.workOrder.update({
        where: { id: workOrder.id },
        data: { invoiceCents },
      })
    }
    await auditAsVendor(
      vendorId,
      {
        action: 'document.uploaded',
        entityType: 'Document',
        entityId: document.id,
        propertyId: workOrder.propertyId,
        after: {
          type: kind,
          fileName: file.name,
          workOrderId: workOrder.id,
          invoiceCents: kind === 'INVOICE' ? invoiceCents : null,
        },
      },
      tx,
    )
  })

  revalidatePath(`/workorders/${workOrder.id}`)
  return { notice: kind === 'INVOICE' ? 'Invoice received - thank you.' : 'Photo received.' }
}

/**
 * Marks the job done (MAINT-03's own lifecycle step before verification).
 * Deliberately does NOT close the work order: R-030 owns the tenant's
 * one-tap "was this resolved?" and everything downstream of it. A vendor
 * saying they are finished and the job actually being finished are two
 * different claims, and only one of them is the vendor's to make.
 */
export async function markWorkComplete(token: string): Promise<VendorFormState> {
  const link = await verifyVendorLink(token)
  if (!link.ok) return { error: vendorRejectionMessage(link.reason) }

  const { workOrder, vendorId } = link
  if (!vendorMayUpload(workOrder.vendorResponse)) {
    return { error: 'Accept the job first.' }
  }
  if (workOrder.status === 'WORK_COMPLETE') return { notice: 'Already marked complete.' }

  await prisma.$transaction(async (tx) => {
    await tx.workOrder.update({
      where: { id: workOrder.id },
      data: { status: 'WORK_COMPLETE', completedAt: new Date() },
    })
    await auditAsVendor(
      vendorId,
      {
        action: 'workorder.vendor_responded',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        propertyId: workOrder.propertyId,
        before: { status: workOrder.status },
        after: { status: 'WORK_COMPLETE' },
      },
      tx,
    )
  })

  revalidatePath(`/workorders/${workOrder.id}`)
  return { notice: 'Marked complete - thank you.' }
}
