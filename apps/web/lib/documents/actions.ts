'use server'

import { createHash } from 'node:crypto'
import {
  type DocumentInput,
  type DocumentTypeValue,
  UNUPLOADABLE_DOCUMENT_TYPES,
  validateDocument,
} from '@rental/core/documents'
import { type ReasonCode, isReasonCode } from '@rental/core/audit'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { extractCapturedAt } from './exif.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Writes for Document (DOC-01, DOC-05, R-012). Same shape as every other
// lib/*/actions.ts: a resource-carrying permission check first, then a
// transaction pairing the write with its audit entry.

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): FormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Uploads a document attached to a property, or to one of its units when
 * `unitId` is given. `unitId`'s property is authoritative when both are
 * present - the unit is fetched and its own `propertyId` used, not the
 * caller-supplied one, so a stale or tampered form field cannot attach a
 * unit's photo to a different property's record.
 */
export async function uploadDocument(
  propertyId: string,
  unitId: string | null,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let resolvedPropertyId = propertyId
  if (unitId) {
    const unit = await prisma.unit.findUniqueOrThrow({ where: { id: unitId } })
    resolvedPropertyId = unit.propertyId
  }
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: resolvedPropertyId },
  })
  const actor = await requirePermission('document.write', propertyResource(property))

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return violationsToState([{ field: 'file', message: 'Choose a file.' }])
  }

  const input: DocumentInput = {
    propertyId: resolvedPropertyId,
    unitId,
    type: str(formData, 'type'),
    fileName: file.name,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  }
  const violations = validateDocument(input)
  if (violations.length > 0) return violationsToState(violations)
  // Server-side too, not only absent from the dropdown (R-119): the five
  // packet and transcript types are minted by the flows that own them, and
  // CONDITION_BASELINE needs a lease this action does not have. A hand-picked
  // value in a POST is the only way left to reach them from here.
  if (UNUPLOADABLE_DOCUMENT_TYPES.includes(input.type as DocumentTypeValue)) {
    return violationsToState([
      {
        field: 'type',
        message: 'That type is created by the process that owns it, not uploaded here.',
      },
    ])
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const capturedAt = await extractCapturedAt(buffer, input.contentType)
  const storageKey = generateStorageKey(resolvedPropertyId, input.fileName)
  // Written before the row exists: a row that fails to commit points at a
  // storageKey nobody reads, which costs disk space; a row that DOES commit
  // pointing at a file that was never written is a document nobody can open.
  // The first failure mode is the cheap one to live with.
  await storage.put(storageKey, buffer, input.contentType)

  await prisma.$transaction(async (tx) => {
    const created = await tx.document.create({
      data: {
        propertyId: resolvedPropertyId,
        unitId,
        type: input.type as never,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        storageKey,
        sha256,
        capturedAt,
        uploadedByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'document.uploaded',
        entityType: 'Document',
        entityId: created.id,
        propertyId: resolvedPropertyId,
        after: { type: created.type, fileName: created.fileName, sizeBytes: created.sizeBytes },
      },
      tx,
    )
    return created
  })

  const returnTo = unitId
    ? `/properties/${resolvedPropertyId}/units/${unitId}`
    : `/properties/${resolvedPropertyId}`
  revalidatePath(returnTo)
  redirect(returnTo)
}

async function documentWithPropertyOrThrow(documentId: string) {
  const document = await prisma.document.findUniqueOrThrow({
    where: { id: documentId },
    include: { property: true },
  })
  if (!document.property) {
    throw new Error(`Document ${documentId} has no property to authorize against`)
  }
  return document
}

/// 'document.delete' is privileged (PRIVILEGED_PERMISSIONS) and MFA-gated by
/// R-004's can() already - no extra check needed here beyond the ordinary
/// requirePermission call.
export async function deleteDocument(
  documentId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const document = await documentWithPropertyOrThrow(documentId)
  await requirePermission('document.delete', propertyResource(document.property!))

  if (document.deletedAt) return { error: 'Already deleted.' }

  const reasonCode = str(formData, 'reasonCode')
  if (!isReasonCode(reasonCode)) {
    return violationsToState([{ field: 'reasonCode', message: 'Choose a reason.' }])
  }
  const reason = str(formData, 'reason') || null

  await prisma.$transaction(async (tx) => {
    // Same double-submission guard as restoreDocument below.
    const { count } = await tx.document.updateMany({
      where: { id: documentId, deletedAt: null },
      data: { deletedAt: new Date() },
    })
    if (count === 0) return
    await audit(
      {
        action: 'document.delete_marked',
        entityType: 'Document',
        entityId: documentId,
        propertyId: document.propertyId,
        before: { deletedAt: null },
        after: { deletedAt: new Date() },
        reasonCode: reasonCode as ReasonCode,
        reason,
      },
      tx,
    )
  })

  const returnTo = document.unitId
    ? `/properties/${document.propertyId}/units/${document.unitId}`
    : `/properties/${document.propertyId}`
  revalidatePath(returnTo)
  redirect(returnTo)
}

export async function restoreDocument(documentId: string): Promise<FormState> {
  const document = await documentWithPropertyOrThrow(documentId)
  await requirePermission('document.delete', propertyResource(document.property!))

  if (!document.deletedAt) return { error: 'This document was never deleted.' }

  await prisma.$transaction(async (tx) => {
    // updateMany + count, not update: a plain update() throws P2025 if a
    // second, near-simultaneous submission of the same restore already won -
    // a real possibility on a plain <button>, which has no built-in
    // double-click guard the way a disabled-while-pending state would add.
    // The loser here should no-op, not crash the request.
    const { count } = await tx.document.updateMany({
      where: { id: documentId, deletedAt: { not: null } },
      data: { deletedAt: null },
    })
    if (count === 0) return
    await audit(
      {
        action: 'document.restored',
        entityType: 'Document',
        entityId: documentId,
        propertyId: document.propertyId,
        before: { deletedAt: document.deletedAt },
        after: { deletedAt: null },
      },
      tx,
    )
  })

  const returnTo = document.unitId
    ? `/properties/${document.propertyId}/units/${document.unitId}`
    : `/properties/${document.propertyId}`
  revalidatePath(returnTo)
  return {}
}
