'use server'

import { createHash } from 'node:crypto'
import { validateDocument } from '@rental/core/documents'
import { CONDITION_BASELINE_DOCUMENT_TYPE } from '@rental/core/leases'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { extractCapturedAt } from '@/lib/documents/exif.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

interface BaselineFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

/**
 * Attaches condition-as-found photographs to an inherited tenancy (RISK-08).
 *
 * ==========================================================================
 * THE WRITE PATH THAT WAS NEVER BUILT (R-116, audit angle 23).
 *
 * `CONDITION_BASELINE_DOCUMENT_TYPE` was read by one query, set by two tests,
 * and written by no route and no action anywhere in the product - while the
 * intake panel, whose entire job is naming the next action, told the owner to
 * "upload the photos below". There was no upload below it, and the "Condition
 * as found" list it pointed at renders only once photos exist, which is
 * exactly false while the gap is open. A read path and a write path were built
 * by different items months apart and only the read path ever had a screen.
 *
 * Deliberately NOT `uploadDocument`: that one is keyed to a property or a
 * unit, redirects to the property page, and lets the uploader pick any type
 * from the vocabulary. This baseline belongs to ONE tenancy - it is the only
 * record of how that house was handed over - so the lease is the FK and the
 * type is not a choice.
 * ==========================================================================
 *
 * Several files in one press: the baseline is a walk round a house, not a
 * document, and making somebody submit it a photo at a time is how half a
 * house ends up photographed.
 */
export async function uploadConditionBaseline(
  leaseId: string,
  _previous: BaselineFormState,
  formData: FormData,
): Promise<BaselineFormState> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      unitId: true,
      property: { select: { id: true, legalEntityId: true } },
    },
  })
  const actor = await requirePermission('document.write', propertyResource(lease.property))

  const files = formData
    .getAll('files')
    .filter((entry): entry is File => entry instanceof File && entry.size > 0)
  if (files.length === 0) {
    return { error: 'Choose at least one photo.', fieldErrors: { files: 'Choose a photo.' } }
  }

  // Every file checked BEFORE any of them is written, so a rejected eleventh
  // photo does not leave ten attached and the uploader guessing which.
  for (const file of files) {
    const violations = validateDocument({
      propertyId: lease.propertyId,
      unitId: lease.unitId,
      type: CONDITION_BASELINE_DOCUMENT_TYPE,
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    })
    if (violations.length > 0) {
      // Named, because "one of these is too big" is not actionable when the
      // uploader picked eleven of them.
      return {
        error: `${file.name}: ${violations[0].message}`,
        fieldErrors: { files: violations[0].message },
      }
    }
  }

  for (const file of files) {
    const contentType = file.type || 'application/octet-stream'
    const buffer = Buffer.from(await file.arrayBuffer())
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    // The photo's own EXIF timestamp, not the moment somebody got round to
    // uploading it - which is the whole claim the panel makes about these.
    const capturedAt = await extractCapturedAt(buffer, contentType)
    const storageKey = generateStorageKey(lease.propertyId, file.name)
    // Written before the row exists, the same trade `uploadDocument`
    // documents: a file with no row costs disk, a row with no file is a
    // document nobody can open.
    await storage.put(storageKey, buffer, contentType)

    await prisma.$transaction(async (tx) => {
      const created = await tx.document.create({
        data: {
          propertyId: lease.propertyId,
          unitId: lease.unitId,
          leaseId: lease.id,
          type: CONDITION_BASELINE_DOCUMENT_TYPE,
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
          propertyId: lease.propertyId,
          after: {
            type: created.type,
            fileName: created.fileName,
            sizeBytes: created.sizeBytes,
            leaseId: lease.id,
          },
        },
        tx,
      )
    })
  }

  revalidatePath(`/leases/${leaseId}`)
  return {
    notice: `${files.length} condition photo${files.length === 1 ? '' : 's'} attached to this tenancy.`,
  }
}
