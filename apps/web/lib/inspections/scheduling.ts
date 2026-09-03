'use server'

import {
  entryDecision,
  entryNoticeText,
  validateOverride,
  validateSchedule,
} from '@rental/core/entry'
import { inspectionRequiresEntryNotice } from '@rental/core/inspections'
import { wallClockToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import type { InspectionFormState } from './actions.ts'

// Scheduling an inspection visit, with entry-notice compliance (R-157,
// INSP-01, MAINT-05's posture, D-4).
//
// THE FOURTH CALLER OF entryDecision(), and the one R-073 flagged and
// nothing owned: work orders, showings and abandonment each route entry
// through the jurisdiction's own notice period, while the auto-scheduled
// annual interior walk entered occupied homes with no notice at all. This
// mirrors lib/workorders/scheduling.ts deliberately - same decision, same
// Notice + NoticeDelivery + audit chain, same warn-and-override rather
// than a hard block - because an inspection visit and a repair visit are
// the same legal act: somebody entering a tenant's home.

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export interface InspectionScheduleResult extends InspectionFormState {
  /// Set when the window is inside the notice period and staff have not yet
  /// stated a reason - the form re-renders with the warning and an override
  /// field (the same warn-and-requires shape scheduleEntry gives MAINT-05).
  needsOverride?: { requiredHours: number; shortfallHours: number }
  /// What was submitted, echoed back - React 19 resets uncontrolled fields
  /// once a form action completes, and the warn-and-override path must not
  /// wipe the window the user just typed.
  values?: { scheduledStart: string; scheduledEnd: string; reason: string }
}

/**
 * Schedules the walk, serving an entry notice when one is owed.
 *
 * Same three outcomes as a work-order visit:
 *   - No notice owed (vacant unit, exterior type) or enough notice:
 *     scheduled, with the notice generated, served and logged where one
 *     applies.
 *   - Inside the notice period with NO override reason: nothing is written;
 *     the caller re-renders the warning.
 *   - Inside the notice period WITH a reason: scheduled, override recorded
 *     as entry_notice.overridden (REASON_REQUIRED - the writer itself
 *     refuses it without the reason).
 */
export async function scheduleInspectionEntry(
  inspectionId: string,
  _previous: InspectionScheduleResult,
  formData: FormData,
): Promise<InspectionScheduleResult> {
  const inspection = await prisma.inspection.findUniqueOrThrow({
    where: { id: inspectionId },
    include: {
      property: true,
      unit: { select: { name: true } },
      lease: {
        select: {
          id: true,
          status: true,
          leaseTenants: {
            where: { isPrimary: true },
            select: {
              tenant: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
            },
          },
        },
      },
    },
  })
  const actor = await requirePermission('inspection.write', propertyResource(inspection.property))

  if (inspection.lockedAt || inspection.performedAt) {
    return { error: 'This walk has already been performed.' }
  }

  const input = {
    scheduledStart: str(formData, 'scheduledStart'),
    scheduledEnd: str(formData, 'scheduledEnd'),
    reason: str(formData, 'reason'),
    overrideReason: str(formData, 'overrideReason') || null,
  }
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

  // The PROPERTY's clock, not the server's - same round trip
  // lib/workorders/scheduling.ts documents: `datetime-local` carries no
  // offset, and the notice renders the window property-local.
  const timezone = inspection.property.timezone
  const scheduledStart = wallClockToUtc(input.scheduledStart, timezone)
  const scheduledEnd = wallClockToUtc(input.scheduledEnd, timezone)
  const now = new Date()

  // No notice owed - an exterior walk, or nobody living there. The window
  // is still worth recording (it is what the calendar and the visit run
  // on), there is just no legal chain to attach to it.
  if (!inspectionRequiresEntryNotice(inspection.type, inspection.lease?.status ?? null)) {
    await prisma.inspection.update({
      where: { id: inspectionId },
      data: { scheduledFor: scheduledStart, scheduledEndAt: scheduledEnd },
    })
    revalidatePath(`/inspections/${inspectionId}`)
    return { notice: 'Scheduled.' }
  }

  const rule = await rulesFor(
    { state: inspection.property.state, county: inspection.property.county },
    now,
  )

  const decision = entryDecision({
    scheduledStart,
    // Serving happens as part of this same action, so "when would notice be
    // served" is now - the decision is made BEFORE anything is written.
    noticeServedAt: now,
    entryNoticeHours: rule.entryNoticeHours,
    // An inspection is never an emergency and has no logged
    // permission-to-enter flow (a tenant who says "come today" is the
    // override path, with that fact as the reason).
    isEmergency: false,
    tenantPermissionGrantedAt: null,
  })

  if (!decision.permitted) {
    const overrideViolations = validateOverride(input.overrideReason)
    if (overrideViolations.length > 0) {
      // NOTHING is written - saving the window first would leave a
      // scheduled unlawful entry on the record if the reason never came.
      return {
        error: `This is ${decision.shortfallHours} hour${decision.shortfallHours === 1 ? '' : 's'} inside the ${decision.requiredHours}-hour notice period for ${inspection.property.state}.`,
        fieldErrors: Object.fromEntries(overrideViolations.map((v) => [v.field, v.message])),
        needsOverride: {
          requiredHours: decision.requiredHours!,
          shortfallHours: decision.shortfallHours!,
        },
        values,
      }
    }
  }

  const tenant = inspection.lease?.leaseTenants[0]?.tenant ?? null
  const leaseId = inspection.lease?.id ?? null

  await prisma.$transaction(async (tx) => {
    let noticeId: string | null = null
    if (leaseId && tenant) {
      const notice = await tx.notice.create({
        data: {
          propertyId: inspection.propertyId,
          leaseId,
          type: 'ENTRY_NOTICE',
          addressOfRecord: inspection.property.addressLine1,
          bodyText: entryNoticeText({
            tenantName: `${tenant.firstName} ${tenant.lastName}`,
            addressLine1: inspection.property.addressLine1,
            unitName: inspection.unit.name,
            scheduledStart,
            scheduledEnd,
            reason: input.reason,
            timezone,
            entryNoticeHours: rule.entryNoticeHours,
          }),
          serviceMethod: 'PORTAL',
          servedAt: now,
          servedByStaffId: actor.id,
          // WHICH rule version produced this notice's period (D-4).
          jurisdictionRuleId: rule.id,
        },
      })
      noticeId = notice.id
      await tx.noticeDelivery.create({
        data: {
          noticeId: notice.id,
          method: 'PORTAL',
          servedAt: now,
          servedByStaffId: actor.id,
          jurisdictionRuleId: rule.id,
        },
      })
      await audit(
        {
          action: 'notice.served',
          entityType: 'Notice',
          entityId: notice.id,
          propertyId: inspection.propertyId,
          after: {
            type: 'ENTRY_NOTICE',
            serviceMethod: 'PORTAL',
            scheduledStart: scheduledStart.toISOString(),
            entryNoticeHours: rule.entryNoticeHours,
            jurisdictionRuleId: rule.id,
            inspectionId,
          },
        },
        tx,
      )
    }

    await tx.inspection.update({
      where: { id: inspectionId },
      data: {
        scheduledFor: scheduledStart,
        scheduledEndAt: scheduledEnd,
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
          entityType: 'Inspection',
          entityId: inspectionId,
          propertyId: inspection.propertyId,
          after: {
            scheduledStart: scheduledStart.toISOString(),
            requiredHours: decision.requiredHours,
            shortfallHours: decision.shortfallHours,
            state: inspection.property.state,
            jurisdictionRuleId: rule.id,
          },
          reasonCode: 'other',
          reason: input.overrideReason!,
        },
        tx,
      )
    }
  })

  // Tell the tenant, outside the transaction (R-016's rule).
  if (tenant) {
    try {
      const outcomes = await notify({
        category: 'entry_notice',
        templateKey: 'entry.notice',
        recipient: { type: 'TENANT', id: tenant.id, email: tenant.email, phone: tenant.phone },
        context: {
          tenantName: tenant.firstName,
          addressLine1: inspection.property.addressLine1,
          unitName: inspection.unit.name,
          scheduledStart: scheduledStart.toISOString(),
          scheduledEnd: scheduledEnd.toISOString(),
          timezone,
          reason: input.reason,
        },
        propertyId: inspection.propertyId,
        // Keyed on the WINDOW - a reschedule is a new fact the tenant must
        // hear about (scheduleEntry's own reasoning).
        idempotencyKey: `entry-notice:${inspectionId}:${scheduledStart.getTime()}`,
      })
      await dispatchPendingNotifications(new Date(), 100, {
        deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
      })
    } catch (error) {
      console.error(`[inspections] failed to notify tenant for ${inspectionId}`, error)
    }
  }

  revalidatePath(`/inspections/${inspectionId}`)
  return {
    notice: decision.permitted
      ? 'Scheduled, and the tenant has been told.'
      : 'Scheduled with a logged override - the reason is on the record.',
  }
}
