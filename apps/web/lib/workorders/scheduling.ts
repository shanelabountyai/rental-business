'use server'

import {
  entryDecision,
  entryNoticeText,
  validateOverride,
  validateSchedule,
} from '@rental/core/entry'
import { wallClockToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import type { WorkOrderFormState } from './actions.ts'

// Scheduling a visit, with entry-notice compliance (MAINT-05, COMM-02,
// D-4, R-027).
//
// THE JURISDICTION SEAM'S FIRST REAL CONSUMER. R-010 built `rulesFor()` and
// wrote in its own header that every item needing a notice period "calls
// this - never `prisma.jurisdictionRule` directly, and never a literal
// number". This is the first caller that actually needs one, and it is the
// case D-4 was written for: the hours differ by state, a city can change
// them, and a rule change must apply from its effective date without
// rewriting the visits already scheduled under the old one.
//
// Warn-and-override, not block. MAINT-05 asks for a warning and a logged
// reason, and that is the honest shape: sometimes the tenant phoned an hour
// ago asking you to come today, and refusing outright would just push staff
// to stop recording the schedule at all.

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/// Everything the decision needs, gathered once. The rule is read AS OF now
/// rather than as of the visit: what governs is the rule in force when the
/// notice is served, and a version that takes effect between serving and
/// entering does not retroactively invalidate a notice already given (D-4's
/// "rules apply prospectively; changing a rule never rewrites history").
async function entryContextFor(workOrderId: string) {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: {
      property: true,
      unit: true,
      ticket: {
        select: {
          leaseId: true,
          tenant: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        },
      },
    },
  })

  const rule = await rulesFor(
    { state: workOrder.property.state, county: workOrder.property.county },
    new Date(),
  )

  return { workOrder, rule }
}

export interface ScheduleResult extends WorkOrderFormState {
  /// Set when the window is inside the notice period and staff have not yet
  /// stated a reason. The form re-renders with the warning and an override
  /// field rather than silently failing - MAINT-05's "warns and requires".
  needsOverride?: { requiredHours: number; shortfallHours: number }
  /// What was submitted, echoed back so the form can re-render with it.
  ///
  /// React 19 RESETS uncontrolled fields once a form action completes, so
  /// without this the warn-and-override path wipes the window and reason
  /// the user just typed and makes them enter it all again - on the one
  /// form where they are already being told they did something wrong.
  /// Found by an e2e test that filled in the override reason and watched
  /// the second submit fail validation on an empty start time.
  values?: { scheduledStart: string; scheduledEnd: string; reason: string }
}

/**
 * Schedules the visit, serving an entry notice if one is required.
 *
 * Three outcomes:
 *   - Permitted (emergency, tenant permission, or enough notice): scheduled,
 *     notice generated and logged where one applies.
 *   - Inside the notice period with NO override reason: nothing is written,
 *     and the caller gets `needsOverride` to re-render the warning.
 *   - Inside the notice period WITH a reason: scheduled, and the override is
 *     recorded as `entry_notice.overridden` - an audit action that is in
 *     REASON_REQUIRED, so `recordAudit()` itself refuses to write it without
 *     the reason. The requirement is enforced at the writer, not just here.
 */
export async function scheduleEntry(
  workOrderId: string,
  _previous: ScheduleResult,
  formData: FormData,
): Promise<ScheduleResult> {
  const { workOrder, rule } = await entryContextFor(workOrderId)
  const actor = await requirePermission('workorder.write', propertyResource(workOrder.property))

  if (workOrder.status === 'CLOSED' || workOrder.status === 'CANCELED') {
    return { error: 'This work order is already resolved.' }
  }

  const input = {
    scheduledStart: str(formData, 'scheduledStart'),
    scheduledEnd: str(formData, 'scheduledEnd'),
    reason: str(formData, 'reason'),
    overrideReason: str(formData, 'overrideReason') || null,
  }
  // Echoed back on every early return, so nothing the user typed is lost.
  const values = {
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    reason: input.reason,
  }

  const violations = validateSchedule(input)
  if (violations.length > 0) {
    return {
      error: 'Check the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
      values,
    }
  }

  // THE PROPERTY'S CLOCK, NOT THE SERVER'S. `scheduledStart` arrives from a
  // `datetime-local` input with no offset, so `new Date(...)` would read it
  // in whatever timezone the Node process runs in - UTC on Vercel. That
  // instant is then rendered PROPERTY-LOCAL in the notice body
  // (packages/core/entry/notice.ts), so a PM booking Tuesday 9:00 AM on a
  // Texas property served a legal entry notice saying "between 4:00 AM and
  // 6:00 AM". A wrong-hours notice on a document whose entire purpose is to
  // be defensible later is the worst kind of quiet bug.
  const timezone = workOrder.property.timezone
  const scheduledStart = wallClockToUtc(input.scheduledStart, timezone)
  const scheduledEnd = wallClockToUtc(input.scheduledEnd, timezone)
  const now = new Date()

  const decision = entryDecision({
    scheduledStart,
    // Serving happens as part of this same action, so "when would notice be
    // served" is now. Written this way rather than passing the eventual
    // Notice row's timestamp because the decision has to be made BEFORE
    // anything is written - a notice recorded and then judged insufficient
    // would be a served notice we then decided not to honour.
    noticeServedAt: now,
    entryNoticeHours: rule.entryNoticeHours,
    isEmergency: workOrder.priority === 'EMERGENCY',
    tenantPermissionGrantedAt: workOrder.entryPermissionGrantedAt,
  })

  if (!decision.permitted) {
    const overrideViolations = validateOverride(input.overrideReason)
    if (overrideViolations.length > 0) {
      // NOTHING is written. The window is not saved, no notice is generated,
      // and the caller re-renders with the warning. Saving the schedule and
      // asking for the reason afterwards would leave a scheduled unlawful
      // entry on the record if the second step were never completed.
      return {
        error: `This is ${decision.shortfallHours} hour${decision.shortfallHours === 1 ? '' : 's'} inside the ${decision.requiredHours}-hour notice period for ${workOrder.property.state}.`,
        fieldErrors: Object.fromEntries(overrideViolations.map((v) => [v.field, v.message])),
        needsOverride: {
          requiredHours: decision.requiredHours!,
          shortfallHours: decision.shortfallHours!,
        },
        values,
      }
    }
  }

  const tenant = workOrder.ticket?.tenant ?? null
  const leaseId = workOrder.ticket?.leaseId ?? null

  await prisma.$transaction(async (tx) => {
    // The notice, when the basis is notice at all. An emergency or a logged
    // permission-to-enter needs no notice generated, and generating one
    // anyway would put a document in the record claiming a basis that was
    // not the one relied on.
    let noticeId: string | null = null
    if (decision.basis === 'notice_served' || decision.basis === 'insufficient_notice') {
      if (leaseId && tenant) {
        const notice = await tx.notice.create({
          data: {
            propertyId: workOrder.propertyId,
            leaseId,
            type: 'ENTRY_NOTICE',
            addressOfRecord: workOrder.property.addressLine1,
            bodyText: entryNoticeText({
              tenantName: `${tenant.firstName} ${tenant.lastName}`,
              addressLine1: workOrder.property.addressLine1,
              unitName: workOrder.unit.name,
              scheduledStart,
              scheduledEnd,
              reason: input.reason,
              timezone: workOrder.property.timezone,
              entryNoticeHours: rule.entryNoticeHours,
            }),
            serviceMethod: 'PORTAL',
            servedAt: now,
            servedByStaffId: actor.id,
            // WHICH RULE VERSION produced this notice's period. D-4's whole
            // point: a rule changing next month must not make it impossible
            // to say what the requirement was when this notice went out.
            jurisdictionRuleId: rule.id,
          },
        })
        noticeId = notice.id
        await audit(
          {
            action: 'notice.served',
            entityType: 'Notice',
            entityId: notice.id,
            propertyId: workOrder.propertyId,
            after: {
              type: 'ENTRY_NOTICE',
              serviceMethod: 'PORTAL',
              scheduledStart: scheduledStart.toISOString(),
              entryNoticeHours: rule.entryNoticeHours,
              jurisdictionRuleId: rule.id,
            },
          },
          tx,
        )
      }
    }

    await tx.workOrder.update({
      where: { id: workOrderId },
      data: {
        scheduledStart,
        scheduledEnd,
        status: 'SCHEDULED',
        entryNoticeId: noticeId,
        ...(decision.permitted
          ? { entryOverrideReason: null, entryOverriddenAt: null }
          : { entryOverrideReason: input.overrideReason, entryOverriddenAt: now }),
      },
    })

    if (!decision.permitted) {
      await audit(
        {
          action: 'entry_notice.overridden',
          entityType: 'WorkOrder',
          entityId: workOrderId,
          propertyId: workOrder.propertyId,
          after: {
            scheduledStart: scheduledStart.toISOString(),
            requiredHours: decision.requiredHours,
            shortfallHours: decision.shortfallHours,
            state: workOrder.property.state,
            jurisdictionRuleId: rule.id,
          },
          // entry_notice.overridden is in REASON_REQUIRED, so recordAudit()
          // throws without these. The reason is the record.
          reasonCode: 'emergency',
          reason: input.overrideReason!,
        },
        tx,
      )
    }
  })

  // Tell the tenant, outside the transaction (R-016's own rule: notify
  // decides and records, dispatch sends, and neither belongs inside a
  // transaction that is holding row locks).
  if (tenant) {
    try {
      const outcomes = await notify({
        category: 'entry_notice',
        templateKey: 'entry.notice',
        recipient: { type: 'TENANT', id: tenant.id, email: tenant.email, phone: tenant.phone },
        context: {
          tenantName: tenant.firstName,
          addressLine1: workOrder.property.addressLine1,
          unitName: workOrder.unit.name,
          scheduledStart: scheduledStart.toISOString(),
          scheduledEnd: scheduledEnd.toISOString(),
          timezone: workOrder.property.timezone,
          reason: input.reason,
        },
        propertyId: workOrder.propertyId,
        // Keyed on the WINDOW, not just the work order: rescheduling is a new
        // fact the tenant must hear about, and a key of only the work order
        // would swallow every reschedule after the first.
        idempotencyKey: `entry-notice:${workOrderId}:${scheduledStart.getTime()}`,
      })
      await dispatchPendingNotifications(new Date(), 100, {
        deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
      })
    } catch (error) {
      console.error(`[entry] failed to notify tenant for ${workOrderId}`, error)
    }
  }

  revalidatePath(`/workorders/${workOrderId}`)
  return {
    notice: decision.permitted
      ? 'Scheduled, and the tenant has been told.'
      : 'Scheduled with a logged override - the reason is on the record.',
  }
}

/**
 * Records that the tenant let us in without formal notice (MAINT-05's
 * "tenant grants logged permission-to-enter").
 *
 * Logged with WHO recorded it and WHEN, because "they said it was fine" is
 * worth nothing in a dispute unless it was written down before the visit -
 * which is also why `entryDecision()` refuses a grant timestamped after the
 * window opened.
 */
export async function logEntryPermission(
  workOrderId: string,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { property: true },
  })
  const actor = await requirePermission('workorder.write', propertyResource(workOrder.property))

  await prisma.$transaction(async (tx) => {
    await tx.workOrder.update({
      where: { id: workOrderId },
      data: { entryPermissionGrantedAt: new Date(), entryPermissionLoggedByStaffId: actor.id },
    })
    await audit(
      {
        action: 'notice.served',
        entityType: 'WorkOrder',
        entityId: workOrderId,
        propertyId: workOrder.propertyId,
        after: { entryBasis: 'tenant_permission', loggedByStaffId: actor.id },
      },
      tx,
    )
  })

  revalidatePath(`/workorders/${workOrderId}`)
  return { notice: 'Permission to enter recorded.' }
}

/**
 * Logs that the tenant did not show (MAINT-05: "a tenant no-show is logged -
 * trip-charge/billback evidence").
 *
 * Recorded rather than acted on. Whether a trip charge is actually posted is
 * MAINT-07's chargeback flow (R-030) and a money decision with its own
 * approval path; this is the timestamped fact that flow will argue from.
 */
export async function logTenantNoShow(
  workOrderId: string,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { property: true },
  })
  await requirePermission('workorder.write', propertyResource(workOrder.property))

  if (!workOrder.scheduledStart) {
    return { error: 'Schedule a window first - a no-show needs an appointment to have been missed.' }
  }
  // Captured before the transaction: TypeScript's narrowing from the guard
  // above does not survive into the async closure below.
  const missedWindowStart = workOrder.scheduledStart

  await prisma.$transaction(async (tx) => {
    await tx.workOrder.update({
      where: { id: workOrderId },
      data: { tenantNoShowAt: new Date(), status: 'WAITING_ON_TENANT' },
    })
    await audit(
      {
        action: 'workorder.vendor_responded',
        entityType: 'WorkOrder',
        entityId: workOrderId,
        propertyId: workOrder.propertyId,
        before: { status: workOrder.status },
        after: {
          tenantNoShow: true,
          scheduledStart: missedWindowStart.toISOString(),
          status: 'WAITING_ON_TENANT',
        },
      },
      tx,
    )
  })

  revalidatePath(`/workorders/${workOrderId}`)
  return { notice: 'No-show recorded as evidence.' }
}
