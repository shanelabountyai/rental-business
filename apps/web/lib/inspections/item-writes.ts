import 'server-only'

import { createHash } from 'node:crypto'
import { validateItemRecord } from '@rental/core/inspections'
import { prisma } from '@rental/db'
import { extractCapturedAt, extractGeotag } from '@/lib/documents/exif.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// The actual InspectionItem writes (INSP-01, R-068), shared behind BOTH the
// staff path (lib/inspections/actions.ts) and the tenant's own self-guided
// path (lib/portal/inspection-actions.ts, INSP-05/R-074). Recording a
// condition or a photo is the identical write either way - only the
// permission check in front differs (`inspection.write` vs a tenant's own
// lease scope, gated on `Inspection.selfGuided`). Extracted once a second
// caller needed it, the same call R-020's `visibleDocumentWhere` already
// made for an identical drift.

export interface FieldViolation {
  error: string
  fieldErrors: Record<string, string>
}

/// Validates and writes one item's condition + notes. Returns a violation to
/// surface on bad input, null on success - the caller turns either into its
/// own form state and revalidates its own path.
export async function writeItemCondition(
  itemId: string,
  input: { condition: string; notes: string | null },
): Promise<FieldViolation | null> {
  const violations = validateItemRecord(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }
  await prisma.inspectionItem.update({
    where: { id: itemId },
    data: { condition: input.condition as never, notes: input.notes },
  })
  return null
}

/// Stores one item's photo - hash, EXIF capture time + geotag, storage put,
/// `Document` row - identical whether staff or a tenant took it.
export async function writeItemPhoto(
  item: { id: string; propertyId: string; leaseId: string | null },
  file: File,
): Promise<void> {
  const buffer = Buffer.from(await file.arrayBuffer())
  const contentType = file.type || 'application/octet-stream'
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const capturedAt = await extractCapturedAt(buffer, contentType)
  const geotag = await extractGeotag(buffer, contentType)
  const storageKey = generateStorageKey(item.propertyId, file.name)
  // Written before the row exists - same ordering documents/actions.ts's own
  // uploadDocument uses: an orphaned file costs disk space, an orphaned
  // pointer is a document nobody can ever open.
  await storage.put(storageKey, buffer, contentType)

  await prisma.document.create({
    data: {
      propertyId: item.propertyId,
      // Set whenever the inspection has one, so the tenant portal's own
      // document visibility rule (tenantCanSeeDocument, DOC-03) already
      // covers it.
      leaseId: item.leaseId,
      inspectionItemId: item.id,
      type: 'INSPECTION_PHOTO',
      fileName: file.name,
      contentType,
      sizeBytes: file.size,
      storageKey,
      sha256,
      capturedAt,
      latitude: geotag?.latitude,
      longitude: geotag?.longitude,
    },
  })
}
