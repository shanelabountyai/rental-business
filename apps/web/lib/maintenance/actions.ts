'use server'

import { createHash } from 'node:crypto'
import {
  EMERGENCY_DEFINITIONS,
  type EmergencyCategory,
  type EmergencyRequestInput,
  type MaintenanceRequestInput,
  type PhoneLoggedRequestInput,
  formatEmergencyDescription,
  formatMaintenanceDescription,
  formatPhoneLoggedDescription,
  detectHabitabilityLanguage,
  isMaintenanceCategory,
  validateEmergencyRequest,
  validateMaintenanceRequest,
  validatePhoneLoggedRequest,
} from '@rental/core/maintenance'
import { prisma } from '@rental/db'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { emitEvent } from '@/lib/jobs/outbox.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import { onCallStaffForProperty, unitForEmergency } from './emergency.ts'
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

export type SubmitMaintenanceRequestResult = MaintenanceFormState | { ticketId: string }

/**
 * Creates the Ticket (MAINT-01's whole point) and attaches whatever photos
 * are ready.
 *
 * `source: 'PORTAL'` and `priority` stays at its ROUTINE default - R-023's
 * triage queue is what turns category and the habitability flag into a
 * suggested priority with staff override; guessing at priority here would be
 * a second, competing opinion about the same decision. (The emergency path
 * below is the one exception, and for a reason that is not a guess: the
 * tenant selected an emergency category outright.)
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

// ---------------------------------------------------------------------------
// The emergency intake path (MAINT-01's emergency criterion, R-020)
// ---------------------------------------------------------------------------

export type SubmitEmergencyResult = MaintenanceFormState | { ticketId: string }

/**
 * Creates an EMERGENCY ticket and pages on-call immediately.
 *
 * THREE THINGS DIFFER FROM THE ORDINARY PATH, all of them deliberate:
 *
 *   `priority: 'EMERGENCY'` is set here rather than left to R-023's triage.
 *   Everywhere else this build refuses to guess at priority, because a
 *   category is weak evidence for one. Here it is not a guess: the tenant
 *   read "I smell gas" and chose it.
 *
 *   The page is sent DIRECTLY, not through the outbox. R-006's dispatcher
 *   already says so in its own comment - "a latency floor of one hour for
 *   anything that only the bus drives, which is fine for nightly work and
 *   NOT fine for an emergency maintenance page". `notify()` decides and
 *   records, then `dispatchPendingNotifications()` runs in the same request,
 *   which is exactly the "a staff-initiated send calls both in the same
 *   request" pattern R-016 documented for latency that matters.
 *
 *   `ticket.created` is still emitted to the outbox afterwards, for
 *   consumers that are not time-critical (R-023's triage queue, reporting).
 *   The page does not depend on it.
 *
 * Quiet hours are bypassed automatically: `maintenance_emergency` is in
 * R-016's EMERGENCY_CATEGORIES, so `notify()` never defers it. That is what
 * makes "regardless of hour" true rather than merely intended - and it is
 * also why nothing here re-implements a quiet-hours check.
 */
export async function submitEmergencyRequest(
  args: EmergencyRequestInput,
): Promise<SubmitEmergencyResult> {
  const { tenant, scope } = await requireTenantWithScope()

  const violations = validateEmergencyRequest(args)
  if (violations.length > 0) {
    return {
      error: 'A couple of things still need an answer.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }
  const category = args.category as EmergencyCategory

  const home = await unitForEmergency(scope)
  if (!home) {
    return {
      error:
        'We do not have a home on file for you yet. Please call or text the number on your lease.',
    }
  }

  const description = formatEmergencyDescription(category, args)
  const definition = EMERGENCY_DEFINITIONS[category]

  const ticket = await prisma.$transaction(async (tx) => {
    const created = await tx.ticket.create({
      data: {
        propertyId: home.propertyId,
        unitId: home.unitId,
        leaseId: home.id,
        tenantId: tenant.id,
        source: 'PORTAL',
        category,
        description,
        priority: 'EMERGENCY',
        entryPermission: args.entryPermission === true,
        petWarning: args.petWarning === true,
        // Every one of MAINT-01's emergency categories is a habitability
        // matter by definition - no heat in freezing temps, sewage, and a
        // gas leak are the textbook examples. Set outright rather than run
        // through R-019's keyword scan, which reads free text the tenant is
        // not required to write here.
        habitabilityFlag: true,
      },
    })
    await audit(
      {
        action: 'ticket.submitted',
        entityType: 'Ticket',
        entityId: created.id,
        propertyId: home.propertyId,
        after: { category, priority: 'EMERGENCY', emergency: true },
      },
      tx,
    )
    await emitEvent(tx, {
      type: 'ticket.created',
      aggregateType: 'Ticket',
      aggregateId: created.id,
      propertyId: home.propertyId,
      payload: { category, priority: 'EMERGENCY' },
    })
    return created
  })

  if (definition.pagesOnCall) {
    await pageOnCall(ticket.id, home, category, tenant, args)
  }

  return { ticketId: ticket.id }
}

/**
 * Pages everyone on call for this property, then flushes the queue in the
 * same request.
 *
 * Wrapped in its own try/catch and never allowed to fail the submission: the
 * ticket is already committed at this point, and a provider outage must not
 * turn "we recorded your emergency" into an error screen that makes a tenant
 * think nothing was reported. A failed page is recorded on the notification's
 * own delivery row (R-016), which is where a support conversation looks.
 */
async function pageOnCall(
  ticketId: string,
  home: NonNullable<Awaited<ReturnType<typeof unitForEmergency>>>,
  category: EmergencyCategory,
  tenant: { id: string; name: string },
  args: EmergencyRequestInput,
): Promise<void> {
  try {
    const [recipients, tenantRecord] = await Promise.all([
      onCallStaffForProperty(home.propertyId),
      prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { phone: true },
      }),
    ])

    for (const staff of recipients) {
      await notify({
        category: 'maintenance_emergency',
        templateKey: 'maintenance.emergency',
        recipient: {
          type: 'STAFF',
          id: staff.id,
          email: staff.email,
          phone: staff.phone,
        },
        context: {
          emergencyLabel: EMERGENCY_DEFINITIONS[category].label,
          propertyName: home.property.name,
          addressLine1: home.property.addressLine1,
          unitName: home.unit.name,
          tenantName: tenant.name,
          tenantPhone: tenantRecord?.phone ?? null,
          petWarning: args.petWarning === true,
          entryPermission: args.entryPermission === true,
        },
        propertyId: home.propertyId,
        // Keyed on the ticket: one page per emergency per recipient, however
        // many times a jittery tenant taps Send.
        idempotencyKey: `emergency:${ticketId}:${staff.id}`,
      })
    }

    // The "immediately" half. Without this the page waits for the hourly
    // cron - see this function's own caller comment.
    await dispatchPendingNotifications()
  } catch (error) {
    console.error(`[emergency] failed to page on-call for ticket ${ticketId}`, error)
  }
}

// ---------------------------------------------------------------------------
// Staff-logged (phone-reported) requests (MAINT-01, D-10, R-022)
// ---------------------------------------------------------------------------

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function optionalBool(formData: FormData, name: string): boolean | undefined {
  const raw = str(formData, name)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

/**
 * Creates a Ticket from a call staff is on right now - structurally
 * identical to a tenant's own submission (same fields, same downstream
 * triage), `source: PHONE_LOGGED` instead of `PORTAL`, so a tenant who never
 * opens the portal is not a second-class record in the queue (the backlog's
 * own framing for R-022).
 *
 * A plain `<form action>`, unlike the tenant wizard's imperative calls above
 * - there is no per-category step sequence to walk here, so the ordinary
 * Server Actions form binding (units/actions.ts, tasks/actions.ts) is the
 * simpler fit. Permission is re-checked against the property actually on the
 * submitted lease, not merely "did the page that rendered this form filter
 * to properties this actor may write" - the same defense-in-depth every
 * other lib/*\/actions.ts write in this repo applies.
 */
export async function logPhoneMaintenanceRequest(
  _previous: MaintenanceFormState,
  formData: FormData,
): Promise<MaintenanceFormState> {
  const leaseTenantId = str(formData, 'leaseTenantId')
  if (!leaseTenantId) return { error: 'Choose who this call is about.' }

  const leaseTenant = await prisma.leaseTenant.findUnique({
    where: { id: leaseTenantId },
    select: {
      tenantId: true,
      lease: {
        select: {
          id: true,
          unitId: true,
          property: { select: { id: true, legalEntityId: true } },
        },
      },
    },
  })
  if (!leaseTenant) return { error: 'That tenant could not be found.' }
  const { property } = leaseTenant.lease
  await requirePermission('ticket.write', propertyResource(property))

  const input: PhoneLoggedRequestInput = {
    category: str(formData, 'category'),
    notes: str(formData, 'notes'),
    entryPermission: optionalBool(formData, 'entryPermission'),
    petWarning: optionalBool(formData, 'petWarning'),
    petNote: str(formData, 'petNote') || undefined,
  }
  if (!isMaintenanceCategory(input.category)) {
    return { error: 'Choose a category.' }
  }
  const violations = validatePhoneLoggedRequest(input)
  if (violations.length > 0) {
    return {
      error: 'A few things need an answer before this can be logged.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  const description = formatPhoneLoggedDescription(input.category, input)
  const habitabilityFlag = detectHabitabilityLanguage(input.notes)

  const ticket = await prisma.$transaction(async (tx) => {
    const created = await tx.ticket.create({
      data: {
        propertyId: property.id,
        unitId: leaseTenant.lease.unitId,
        leaseId: leaseTenant.lease.id,
        tenantId: leaseTenant.tenantId,
        source: 'PHONE_LOGGED',
        category: input.category,
        description,
        entryPermission: input.entryPermission === true,
        petWarning: input.petWarning === true,
        habitabilityFlag,
      },
    })
    await audit(
      {
        action: 'ticket.submitted',
        entityType: 'Ticket',
        entityId: created.id,
        propertyId: property.id,
        after: { source: 'PHONE_LOGGED', category: created.category, habitabilityFlag },
      },
      tx,
    )
    return created
  })

  redirect(`/maintenance/${ticket.id}`)
}
