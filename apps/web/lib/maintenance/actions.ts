'use server'

import { createHash } from 'node:crypto'
import {
  EMERGENCY_DEFINITIONS,
  type EmergencyCategory,
  type EmergencyRequestInput,
  type MaintenanceRequestInput,
  type PhoneLoggedRequestInput,
  canMergeTicket,
  isTicketTriageResolved,
  formatEmergencyDescription,
  formatMaintenanceDescription,
  formatPhoneLoggedDescription,
  detectHabitabilityLanguage,
  isMaintenanceCategory,
  suggestTicketPriority,
  validateEmergencyRequest,
  validateMaintenanceRequest,
  validatePhoneLoggedRequest,
} from '@rental/core/maintenance'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { emitEvent } from '@/lib/jobs/outbox.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import { completeTaskWork } from '@/lib/tasks/complete.ts'
import { emergencyPagingPlan, unitForEmergency } from './emergency.ts'
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
 * `source: 'PORTAL'`. Priority is `suggestTicketPriority()`'s starting
 * point, not a guess this function makes itself - category-plus-habitability
 * is the same weak-evidence signal every intake path feeds it (R-023), and a
 * PM can always override it during triage. (The emergency path below sets
 * priority directly instead, and for a reason that is not a guess: the
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
  const priority = suggestTicketPriority({ category: args.category, habitabilityFlag })

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
        priority,
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
    // R-023: every new ticket becomes a triage Task, reacting to this event
    // rather than creating one inline here - see triage-consumer.ts.
    await emitEvent(tx, {
      type: 'ticket.created',
      aggregateType: 'Ticket',
      aggregateId: created.id,
      propertyId: home.propertyId,
      payload: { source: 'PORTAL' },
    })
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
    const [plan, tenantRecord] = await Promise.all([
      emergencyPagingPlan(home.propertyId),
      prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { phone: true },
      }),
    ])

    // WHO, decided by the rota (R-029) rather than by paging everybody. When
    // nobody is on call this is still everybody - see packages/core/oncall
    // for why that fallback is the safe direction and not an oversight.
    const recipients = plan.recipients

    // In PARALLEL, not one recipient after another. Every page is
    // independent, and a tenant standing in sewage is waiting on this whole
    // function: paging four people sequentially costs four round trips of
    // latency for no reason. `allSettled`, so one recipient with a broken
    // record cannot stop the others being paged - which is the entire
    // difference between a bad address and nobody being told.
    const results = await Promise.allSettled(
      recipients.map((staff) =>
        notify({
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
        }),
      ),
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`[emergency] a page could not be recorded for ${ticketId}`, result.reason)
      }
    }

    const deliveryIds = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof notify>>> => r.status === 'fulfilled')
      .flatMap((r) => r.value)
      .map((outcome) => outcome.deliveryId)
      .filter((id): id is string => id != null)

    // The "immediately" half, scoped to THIS emergency's own pages.
    //
    // An unscoped sweep here was a real bug, not a style point: it sends the
    // oldest queued deliveries in the whole system, so an emergency page
    // could sit behind up to a hundred unrelated notifications while the
    // tenant waited on the response - and the wait grew with a backlog that
    // has nothing to do with this property. R-020 asked for "paged
    // immediately"; this is the version that actually delivers that, and it
    // is bounded by the number of people on call rather than by whatever
    // else the product happens to owe.
    await dispatchPendingNotifications(new Date(), 100, { deliveryIds })
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
  const priority = suggestTicketPriority({ category: input.category, habitabilityFlag })

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
        priority,
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
    await emitEvent(tx, {
      type: 'ticket.created',
      aggregateType: 'Ticket',
      aggregateId: created.id,
      propertyId: property.id,
      payload: { source: 'PHONE_LOGGED' },
    })
    return created
  })

  redirect(`/maintenance/${ticket.id}`)
}

// ---------------------------------------------------------------------------
// Triage (MAINT-02, RISK-05, R-023)
// ---------------------------------------------------------------------------

const TRIAGE_PRIORITY_OPTIONS = ['URGENT', 'ROUTINE'] as const

/// A ticket-triage Task's linked Ticket, with the permission check every
/// other write in this file opens with. Not `getStaffTicket` (R-022's own
/// read, scoped by the property SWITCHER's selection) - a write re-derives
/// the property straight from the row being acted on and checks RBAC against
/// THAT, the same defense-in-depth `logPhoneMaintenanceRequest` above
/// applies, so a stale or narrowed switcher selection can never be the only
/// thing standing between an actor and a ticket outside their scope.
async function ticketTriageTaskOrThrow(taskId: string) {
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { property: true },
  })
  if (task.subjectType !== 'Ticket') {
    throw new Error(`Task ${taskId} is not a ticket-triage task`)
  }
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: task.subjectId } })
  const actor = await requirePermission('ticket.write', propertyResource(task.property))
  return { task, ticket, actor }
}

/// Undefined leaves the column untouched (Prisma's own "omit" convention,
/// used throughout this file already for `proof ?? undefined`); a `Date`
/// sets it. Never overwrites an existing timestamp - the clock's job ends
/// the moment a human first engages, whichever action that turns out to be.
function firstResponseStamp(ticket: { firstResponseAt: Date | null }): Date | undefined {
  return ticket.firstResponseAt ? undefined : new Date()
}

/**
 * Overrides the suggested priority (MAINT-02: "suggested priority from
 * category... with override"). Deliberately cannot set EMERGENCY: that
 * priority pages on-call the moment it is chosen (R-020's own intake), and
 * this action has no paging behind it - letting a PM set it here would look
 * like escalating when nothing downstream reacts to it. A ticket that turns
 * out to be a real emergency after the fact needs a human phone call, not a
 * status field.
 *
 * The first override also moves a NEW ticket to TRIAGED and stamps
 * firstResponseAt if unset - looking at a ticket and deciding its priority
 * IS the first response MAINT-02/RISK-05 wants timestamped, whether or not a
 * PM goes on to resolve it in the same visit.
 */
export async function setTicketPriority(
  taskId: string,
  _previous: MaintenanceFormState,
  formData: FormData,
): Promise<MaintenanceFormState> {
  const { task, ticket } = await ticketTriageTaskOrThrow(taskId)

  const priority = String(formData.get('priority') ?? '')
  if (!(TRIAGE_PRIORITY_OPTIONS as readonly string[]).includes(priority)) {
    return { error: 'Choose a priority.' }
  }
  if (isTicketTriageResolved(ticket.status)) {
    return { error: 'This ticket is already resolved.' }
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        priority: priority as never,
        status: ticket.status === 'NEW' ? 'TRIAGED' : undefined,
        firstResponseAt: firstResponseStamp(ticket),
      },
    })
    await audit(
      {
        action: 'ticket.triaged',
        entityType: 'Ticket',
        entityId: ticket.id,
        propertyId: task.propertyId,
        before: { priority: ticket.priority, status: ticket.status },
        after: { priority: updated.priority, status: updated.status },
      },
      tx,
    )
  })

  revalidatePath(`/tasks/${taskId}`)
  revalidatePath('/maintenance')
  revalidatePath(`/maintenance/${ticket.id}`)
  return {}
}

const TRIAGE_RESOLUTIONS = {
  waiting_on_tenant: 'WAITING_ON_TENANT',
  converted: 'CONVERTED',
  closed: 'CLOSED',
} as const
type TriageResolution = keyof typeof TRIAGE_RESOLUTIONS

/**
 * The three terminal triage decisions MAINT-02 names outright: request more
 * info ("waiting on tenant"), convert to work order, or close - none of
 * which need a form, so this takes no FormData. Each also completes the
 * linked Task (a PM does not separately click "complete" after already
 * deciding what happens to the ticket - the decision IS the completion),
 * via the same completeTaskWork() the generic Task queue uses, so a
 * triage-resolved ticket leaves the active queue exactly the way any other
 * finished task does.
 *
 * "Converted" sets `status: CONVERTED` only - it does not create a
 * WorkOrder. That row and its own creation flow (scope, access details, cost
 * estimate, vendor assignment) is R-024's build, which depends on this one
 * existing first; the ticket detail page names R-024 as the reason nothing
 * further renders yet, the same SectionPlaceholder pattern R-022 used for
 * this whole section before this item built it out.
 */
export async function resolveTicketTriage(
  taskId: string,
  resolution: TriageResolution,
): Promise<MaintenanceFormState> {
  const { task, ticket, actor } = await ticketTriageTaskOrThrow(taskId)

  if (isTicketTriageResolved(ticket.status)) {
    return { error: 'This ticket is already resolved.' }
  }
  const status = TRIAGE_RESOLUTIONS[resolution]

  await prisma.$transaction(async (tx) => {
    const updated = await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        status,
        firstResponseAt: firstResponseStamp(ticket),
        closedAt: status === 'CLOSED' ? new Date() : undefined,
      },
    })
    await audit(
      {
        action: 'ticket.triaged',
        entityType: 'Ticket',
        entityId: ticket.id,
        propertyId: task.propertyId,
        before: { status: ticket.status },
        after: { status: updated.status },
      },
      tx,
    )
    await completeTaskWork(tx, task, actor.id, { resolution })
  })

  revalidatePath('/tasks')
  revalidatePath('/maintenance')
  revalidatePath(`/maintenance/${ticket.id}`)
  redirect('/tasks')
}

/**
 * Merges a duplicate into another open ticket at the same property (MAINT-02:
 * "merge duplicates") - the same "a conversation does not become five
 * tickets" idea R-021 already applies to a single thread, extended to two
 * separately-filed reports of the same problem. Completes the source
 * ticket's Task exactly as the other resolutions do; the target ticket and
 * its own Task are untouched; a duplicate merges INTO the survivor, not the
 * other way around.
 */
export async function mergeTicketDuplicate(
  taskId: string,
  _previous: MaintenanceFormState,
  formData: FormData,
): Promise<MaintenanceFormState> {
  const { task, ticket, actor } = await ticketTriageTaskOrThrow(taskId)

  const targetTicketId = String(formData.get('targetTicketId') ?? '')
  if (!targetTicketId) return { error: 'Choose the ticket to merge into.' }

  const target = await prisma.ticket.findUnique({ where: { id: targetTicketId } })
  if (!target) return { error: 'That ticket could not be found.' }

  const violations = canMergeTicket(ticket, target)
  if (violations.length > 0) {
    return { error: violations[0]!.message }
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        status: 'MERGED',
        mergedIntoTicketId: target.id,
        firstResponseAt: firstResponseStamp(ticket),
      },
    })
    await audit(
      {
        action: 'ticket.triaged',
        entityType: 'Ticket',
        entityId: ticket.id,
        propertyId: task.propertyId,
        before: { status: ticket.status, mergedIntoTicketId: null },
        after: { status: updated.status, mergedIntoTicketId: target.id },
      },
      tx,
    )
    await completeTaskWork(tx, task, actor.id, { resolution: 'merged', into: target.id })
  })

  revalidatePath('/tasks')
  revalidatePath('/maintenance')
  revalidatePath(`/maintenance/${ticket.id}`)
  redirect('/tasks')
}

/**
 * Somebody has seen this emergency and is acting on it (NOTIF-05, R-029).
 *
 * ONE CLICK, NO FORM, NO REASON. An acknowledgement that takes a dialogue to
 * record is one nobody makes at 3am from a phone, and the escalation chain
 * only stops when this row is written - a design that makes stopping it
 * awkward pages the owner for every emergency somebody was already driving
 * to.
 *
 * Deliberately NOT `firstResponseAt` (R-023's triage stamp). A page
 * acknowledged at 3am is not a triage decision, and letting ordinary daytime
 * queue work stop the escalation clock would be exactly the silent failure
 * this item exists to prevent.
 *
 * A REAL FORM SUBMISSION, not an onClick handler - which is why it takes
 * FormData. A handler does nothing until React has hydrated, and a dead
 * button on the screen somebody opens at 3am on a bad connection is the
 * failure this whole item exists to prevent.
 */
export async function acknowledgeEmergency(
  _previous: MaintenanceFormState,
  formData: FormData,
): Promise<MaintenanceFormState> {
  const ticketId = String(formData.get('ticketId') ?? '')
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      propertyId: true,
      acknowledgedAt: true,
      property: { select: { id: true, legalEntityId: true } },
    },
  })
  if (!ticket) return { error: 'That ticket could not be found.' }

  const actor = await requirePermission('ticket.write', propertyResource(ticket.property))

  // First acknowledgement wins. A second person clicking it thirty seconds
  // later has not responded thirty seconds later than the first, and
  // overwriting the stamp would move the only measurement of how long a
  // tenant waited.
  if (ticket.acknowledgedAt) return {}

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.ticket.update({
      where: { id: ticket.id },
      data: { acknowledgedAt: now, acknowledgedByStaffId: actor.id },
    })
    await audit(
      {
        action: 'ticket.acknowledged',
        entityType: 'Ticket',
        entityId: ticket.id,
        propertyId: ticket.propertyId,
        after: { acknowledgedAt: now.toISOString(), acknowledgedByStaffId: actor.id },
      },
      tx,
    )
  })

  revalidatePath(`/maintenance/${ticket.id}`)
  revalidatePath('/maintenance')
  return {}
}

/**
 * Marks a vendor as one who answers after hours, or unmarks them (MAINT-12,
 * R-029).
 *
 * Set from the emergency ticket itself rather than from a vendor admin
 * screen, because that screen does not exist yet - R-079 owns vendor
 * management (trades, W-9, COI, preferred and fallback lists) in Phase 2, and
 * this flag will move into it. Until then the honest place to record "this
 * plumber picks up on a Sunday" is the moment somebody finds out, standing on
 * an emergency ticket at 2am, which is also the only moment anybody learns it.
 */
export async function setVendorEmergencyAvailability(
  _previous: MaintenanceFormState,
  formData: FormData,
): Promise<MaintenanceFormState> {
  const vendorId = String(formData.get('vendorId') ?? '')
  const available = formData.get('available') === 'yes'
  // `vendor.write` is the permission that owns the vendor record. Nothing
  // about this being reachable from a ticket makes it a ticket permission.
  const actor = await requirePermission('vendor.write')

  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, emergencyAvailable: true },
  })
  if (!vendor) return { error: 'That vendor could not be found.' }
  if (vendor.emergencyAvailable === available) return {}

  await prisma.$transaction(async (tx) => {
    await tx.vendor.update({
      where: { id: vendorId },
      data: { emergencyAvailable: available },
    })
    await audit(
      {
        action: 'vendor.emergency_availability_changed',
        entityType: 'Vendor',
        entityId: vendorId,
        before: { emergencyAvailable: vendor.emergencyAvailable },
        after: { emergencyAvailable: available, byStaffId: actor.id },
      },
      tx,
    )
  })

  revalidatePath('/maintenance')
  return {}
}
