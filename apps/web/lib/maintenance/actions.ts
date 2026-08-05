'use server'

import { createHash } from 'node:crypto'
import {
  type MaintenanceRequestInput,
  formatMaintenanceDescription,
  detectHabitabilityLanguage,
  isMaintenanceCategory,
  validateMaintenanceRequest,
} from '@rental/core/maintenance'
import { prisma } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import { getTenantCurrentHome } from './queries.ts'

// Writes for the tenant maintenance flow (MAINT-01, R-019).
//
// Called DIRECTLY from client code rather than bound to a <form action> -
// the wizard's shape (a dynamic set of prompts and troubleshooting steps per
// category) does not map cleanly onto a single FormData submission, and
// Next.js Server Actions are ordinary async functions a client component may
// call imperatively. Each one still opens with `requireTenantWithScope()`,
// same as every page - a directly-called action is not exempt from the same
// authorization every portal read and write goes through.

export interface MaintenanceFormState {
  error?: string
  fieldErrors?: Record<string, string>
}

const MAX_PHOTO_BYTES = 15 * 1024 * 1024

/**
 * Uploads one photo, before the Ticket it will belong to exists.
 *
 * THIS IS HALF OF THE "NEVER BLOCKS SUBMISSION" MECHANISM (MAINT-01). The
 * wizard calls this the moment a tenant picks a photo, in the background,
 * and never awaits it before letting them continue to the next step - a
 * tenant on a slow connection keeps moving through the wizard immediately.
 * The Document is created as an ORPHAN (`ticketId` null); the other half,
 * `submitMaintenanceRequest`, attaches whatever has finished uploading by
 * the time Submit resolves - see the wizard's own `waitForPendingUploads`
 * for the short, bounded grace period that gives an upload started seconds
 * ago a real chance to land before Submit moves on without it.
 *
 * ponytail: if the tab closes, or an upload is still running when that grace
 * period runs out, that photo is not attached automatically - there is no
 * background-sync queue here (that is R-028's offline-tolerant flow, built
 * for the tech's job list, not this one). The ticket detail page lets a
 * tenant add a photo after the fact via attachMaintenancePhoto below, which
 * is the practical recovery path for a dropped upload today.
 */
export async function uploadMaintenancePhoto(
  file: File,
): Promise<{ id: string } | { error: string }> {
  const { tenant, scope } = await requireTenantWithScope()

  if (!file.type.startsWith('image/')) {
    return { error: 'Only photos can be attached here.' }
  }
  if (file.size === 0 || file.size > MAX_PHOTO_BYTES) {
    return { error: 'Choose a photo under 15MB.' }
  }

  const home = await getTenantCurrentHome(scope)
  if (!home) return { error: 'No home on file to attach this to.' }

  const buffer = Buffer.from(await file.arrayBuffer())
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const storageKey = generateStorageKey(home.propertyId, file.name)
  await storage.put(storageKey, buffer, file.type)

  const created = await prisma.document.create({
    data: {
      propertyId: home.propertyId,
      unitId: home.unitId,
      tenantId: tenant.id,
      type: 'MAINTENANCE_PHOTO',
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      storageKey,
      sha256,
    },
  })

  return { id: created.id }
}

/// Links a photo (already uploaded via uploadMaintenancePhoto) to a ticket.
/// Verifies the document belongs to THIS tenant and is not already attached
/// to something else - the two checks that stop a guessed document id from
/// attaching somebody else's photo to a tenant's own ticket.
async function attachMaintenancePhotoInternal(
  tenantId: string,
  ticketId: string,
  documentId: string,
) {
  await prisma.document.updateMany({
    where: {
      id: documentId,
      tenantId,
      ticketId: null,
    },
    data: { ticketId },
  })
}

/**
 * Attaches one already-uploaded photo to an EXISTING ticket.
 *
 * Two callers: the wizard's own `.then()` continuation for a photo still
 * uploading when Submit was clicked (see uploadMaintenancePhoto), and the
 * ticket detail page's "add a photo" affordance, which is the same mechanism
 * offered again after submission - both the straggler-upload recovery path
 * and an ordinary feature.
 */
export async function attachMaintenancePhoto(
  ticketId: string,
  documentId: string,
): Promise<{ error?: string }> {
  const { tenant, scope } = await requireTenantWithScope()

  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, tenantId: scope.tenantId },
    select: { id: true },
  })
  if (!ticket) return { error: 'That request could not be found.' }

  await attachMaintenancePhotoInternal(tenant.id, ticketId, documentId)
  return {}
}

export interface SubmitMaintenanceRequestArgs extends MaintenanceRequestInput {
  /// Document ids from uploadMaintenancePhoto that had already resolved by
  /// the time Submit was clicked. Never awaited to collect more - see
  /// uploadMaintenancePhoto's own comment.
  photoDocumentIds: readonly string[]
}

/**
 * Creates the Ticket (MAINT-01's whole point) and attaches whatever photos
 * are ready.
 *
 * `source: 'PORTAL'` and `priority` stays at its ROUTINE default - R-023's
 * triage queue is what turns category and the habitability flag into a
 * suggested priority with staff override; guessing at priority here would be
 * a second, competing opinion about the same decision.
 */
export type SubmitMaintenanceRequestResult = MaintenanceFormState | { ticketId: string }

/**
 * Creates the Ticket (MAINT-01's whole point) and attaches whatever photos
 * are ready.
 *
 * Returns `{ ticketId }` rather than calling `redirect()` itself - the
 * wizard needs the id BEFORE it navigates, so it can record it (as the
 * target for any photo still uploading) ahead of pushing the new route. A
 * server-side redirect here would deliver the navigation but never hand the
 * id back to the caller, which is exactly the gap that let this file ship
 * with a real bug: `submittedTicketId.current` was declared and read, but
 * never actually assigned, so a photo still in flight when Submit was
 * clicked had no id to attach itself to once it finished. A test with a slow
 * enough upload (or, as it turned out, an automated test clicking through
 * the remaining steps faster than the request can resolve) caught it.
 */
export async function submitMaintenanceRequest(
  args: SubmitMaintenanceRequestArgs,
): Promise<SubmitMaintenanceRequestResult> {
  const { tenant, scope } = await requireTenantWithScope()

  if (!isMaintenanceCategory(args.category)) {
    return { error: 'Choose a category.' }
  }
  const violations = validateMaintenanceRequest(args)
  if (violations.length > 0) {
    return {
      error: 'A few things need an answer before this can be submitted.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  const home = await getTenantCurrentHome(scope)
  if (!home) {
    return { error: 'We do not have a home on file for you yet. Send us a message instead.' }
  }

  const description = formatMaintenanceDescription(args.category, args)
  const habitabilityFlag = detectHabitabilityLanguage(description)

  const ticket = await prisma.$transaction(async (tx) => {
    const created = await tx.ticket.create({
      data: {
        propertyId: home.propertyId,
        unitId: home.unitId,
        leaseId: home.id,
        tenantId: tenant.id,
        source: 'PORTAL',
        category: args.category,
        description,
        entryPermission: args.entryPermission === true,
        petWarning: args.petWarning === true,
        habitabilityFlag,
      },
    })
    await audit(
      {
        action: 'ticket.submitted',
        entityType: 'Ticket',
        entityId: created.id,
        propertyId: home.propertyId,
        after: { category: created.category, habitabilityFlag },
      },
      tx,
    )
    return created
  })

  for (const documentId of args.photoDocumentIds) {
    await attachMaintenancePhotoInternal(tenant.id, ticket.id, documentId)
  }

  return { ticketId: ticket.id }
}
