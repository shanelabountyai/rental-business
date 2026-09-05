'use server'

import { createHash } from 'node:crypto'
import {
  type DocumentTypeValue,
  UNUPLOADABLE_DOCUMENT_TYPES,
  validateDocument,
} from '@rental/core/documents'
import { parseCsv } from '@rental/core/import'
import { addressComparisonKey } from '@rental/core/property'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { extractCapturedAt } from '@/lib/documents/exif.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Bulk document upload keyed by address + type (R-168, PRD §6.8), the third
// piece of the import item alongside `lib/import/actions.ts`'s entity/lease
// CSV. Single-step, unlike that one: uploading a file that already exists in
// this portfolio has no double-booking failure mode the way a duplicate
// lease would, so there is nothing a dry-run buys here that a per-file
// result list does not - a row either matches an existing property and
// lands, or it names what went wrong.
//
// Every file goes through the SAME write `uploadDocument`
// (lib/documents/actions.ts) uses - the storage adapter, the sha256, the
// EXIF capture time, the closed DOCUMENT_TYPES vocabulary and its
// UNUPLOADABLE exclusions - so a bulk-imported document is never a
// second-class record next to one uploaded through the property page.
//
// Manifest columns: property_address_line1, property_postal_code, type,
// file_name. Only EXISTING properties are matched - this never creates one
// (the entity/lease CSV above does that); a manifest row naming an address
// with no property yet is an error, not a silent property creation.

const MANIFEST_COLUMNS = ['property_address_line1', 'property_postal_code', 'type', 'file_name'] as const

export interface BulkDocumentResult {
  line: number
  fileName: string
  status: 'uploaded' | 'error'
  message: string
}

export interface BulkDocumentFormState {
  error?: string
  notice?: string
  results?: BulkDocumentResult[]
}

export async function bulkUploadDocuments(
  _previous: BulkDocumentFormState,
  formData: FormData,
): Promise<BulkDocumentFormState> {
  const actor = await requirePermission('property.write')

  const manifest = formData.get('manifest')
  if (!(manifest instanceof File) || manifest.size === 0) {
    return { error: 'Choose a manifest CSV.' }
  }
  const rows = parseCsv(await manifest.text())
  if (rows.length < 2) return { error: 'That manifest has no rows.' }
  const [header, ...data] = rows

  const columnIndex = new Map(
    MANIFEST_COLUMNS.map((name) => [name, header!.findIndex((h) => h.trim().toLowerCase() === name)]),
  )
  const missing = MANIFEST_COLUMNS.filter((name) => (columnIndex.get(name) ?? -1) < 0)
  if (missing.length > 0) {
    return { error: `Manifest header is missing: ${missing.join(', ')}.` }
  }
  const cell = (raw: string[], column: (typeof MANIFEST_COLUMNS)[number]): string =>
    (raw[columnIndex.get(column)!] ?? '').trim()

  const uploaded = formData.getAll('files').filter((f): f is File => f instanceof File)
  const fileByName = new Map(uploaded.map((f) => [f.name, f]))

  const properties = await prisma.property.findMany({
    select: { id: true, addressLine1: true, postalCode: true },
  })
  const propertyIdByKey = new Map(properties.map((p) => [addressComparisonKey(p), p.id]))

  const results: BulkDocumentResult[] = []

  for (const [index, raw] of data.entries()) {
    const line = index + 2
    if (raw.every((c) => c.trim() === '')) continue

    const fileName = cell(raw, 'file_name')
    const addressLine1 = cell(raw, 'property_address_line1')
    const postalCode = cell(raw, 'property_postal_code')
    const type = cell(raw, 'type').toUpperCase()

    const propertyId =
      addressLine1 && postalCode ? propertyIdByKey.get(addressComparisonKey({ addressLine1, postalCode })) : undefined
    if (!propertyId) {
      results.push({ line, fileName, status: 'error', message: 'No property matches that address.' })
      continue
    }
    const file = fileByName.get(fileName)
    if (!file) {
      results.push({ line, fileName, status: 'error', message: 'No uploaded file with that name.' })
      continue
    }
    if (UNUPLOADABLE_DOCUMENT_TYPES.includes(type as DocumentTypeValue)) {
      results.push({
        line,
        fileName,
        status: 'error',
        message: 'That type is created by the process that owns it, not uploaded here.',
      })
      continue
    }
    const violations = validateDocument({
      propertyId,
      unitId: null,
      type,
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    })
    if (violations.length > 0) {
      results.push({ line, fileName, status: 'error', message: violations.map((v) => v.message).join(' ') })
      continue
    }

    const contentType = file.type || 'application/octet-stream'
    const buffer = Buffer.from(await file.arrayBuffer())
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const capturedAt = await extractCapturedAt(buffer, contentType)
    const storageKey = generateStorageKey(propertyId, file.name)
    await storage.put(storageKey, buffer, contentType)

    await prisma.$transaction(async (tx) => {
      const created = await tx.document.create({
        data: {
          propertyId,
          unitId: null,
          type: type as never,
          fileName: file.name,
          contentType,
          sizeBytes: file.size,
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
          propertyId,
          after: { type: created.type, fileName: created.fileName, sizeBytes: created.sizeBytes, source: 'bulk_import' },
        },
        tx,
      )
    })
    results.push({ line, fileName, status: 'uploaded', message: 'Uploaded.' })
  }

  revalidatePath('/properties')

  const uploadedCount = results.filter((r) => r.status === 'uploaded').length
  return {
    results,
    notice: uploadedCount > 0 ? `Uploaded ${uploadedCount} of ${results.length} files.` : undefined,
    error: results.length > 0 && uploadedCount === 0 ? 'No files uploaded — see the results below.' : undefined,
  }
}
