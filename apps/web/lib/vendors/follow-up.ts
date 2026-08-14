import 'server-only'

import { businessDate } from '@rental/core/scheduling'
import { type Priority, prisma } from '@rental/db'
import { notify } from '@/lib/notifications/send.ts'
import { staffForProperty } from '@/lib/notifications/consumers.ts'
import { createTask } from '@/lib/tasks/create.ts'

// Somebody is subscribed to the vendor (MAINT-03, COMM-06, R-032a; D-9).
//
// R-025 gave vendors a way to answer and R-032 gave them a way to talk, and
// NOTHING WAS LISTENING TO EITHER. A vendor could accept, decline, propose a
// different time, send a message or upload an invoice, and the only trace was
// an audit row nobody reads. The work order changed state and no work appeared
// in anybody's queue.
//
// ==========================================================================
// A DECLINE IS WORSE THAN SILENCE, which is the defect that named this item.
//
// `sweepUnansweredDispatches` finds jobs where `vendorRespondedAt` is null.
// A vendor who declines HAS responded, so they step straight over that
// filter - a vendor who ignores us raises a re-dispatch prompt, and a vendor
// who says "no" raises nothing at all. The job silently returns to the
// unassigned queue, and an urgent leak sits there overnight.
//
// Fixed HERE rather than by widening that query, deliberately. The sweep
// exists to notice an absence, and it needs a timer to do it; a decline is a
// present, timestamped event we are already handling, and making an hourly
// cron responsible for reacting to it would add up to an hour of latency to
// the one case that cannot afford it.
// ==========================================================================
//
// EVERY OUTCOME IS A TASK IN THE ONE QUEUE (D-9). Two of them also notify,
// and only two: a decline, because somebody has to call another vendor
// tonight, and an inbound message, because a channel nobody reads is worse
// than no channel. An acceptance and an invoice are work for tomorrow and
// live in the queue where tomorrow's work lives - notifying on all five is
// how a queue trains people to ignore it.

type VendorEvent =
  | { kind: 'declined'; declineReason: string | null }
  | { kind: 'accepted' }
  | { kind: 'proposed_time' }
  | { kind: 'message'; body: string }
  | { kind: 'invoice'; overCeiling: boolean }

interface FollowUpWorkOrder {
  id: string
  propertyId: string
  scope: string
  /// The job's own priority, carried straight through to the tasks that
  /// represent it. Typed as Prisma's enum rather than `string` so a declined
  /// emergency cannot silently become a routine one.
  priority: Priority
  unit: { name: string }
  property: { name: string; timezone: string }
  vendor: { name: string } | null
}

/// The work order shape this needs, in one place so every call site selects
/// the same thing and a missing field is a compile error rather than a
/// notification with "undefined" in it.
export const FOLLOW_UP_SELECT = {
  id: true,
  propertyId: true,
  scope: true,
  priority: true,
  unit: { select: { name: true } },
  property: { select: { name: true, timezone: true } },
  vendor: { select: { name: true } },
} as const

/**
 * Raises the work, and tells somebody when it will not keep.
 *
 * NEVER THROWS INTO ITS CALLER. Every call site is a vendor standing in a
 * driveway on a magic link who has just done what we asked. If our queue or
 * our mail provider is down, their acceptance still happened and the page
 * must still say thank you - the follow-up is ours to retry, not their
 * problem to see an error about. The failure is logged, loudly, because a
 * silently dropped re-dispatch prompt is exactly the defect this file exists
 * to close.
 */
export async function vendorFollowUp(
  workOrder: FollowUpWorkOrder,
  event: VendorEvent,
  now = new Date(),
): Promise<void> {
  try {
    await raise(workOrder, event, now)
  } catch (error) {
    console.error(
      `[vendor] follow-up failed for work order ${workOrder.id} after ${event.kind}`,
      error,
    )
  }
}

async function raise(
  workOrder: FollowUpWorkOrder,
  event: VendorEvent,
  now: Date,
): Promise<void> {
  const vendorName = workOrder.vendor?.name ?? 'The vendor'
  const where = `${workOrder.scope.slice(0, 40)} (${workOrder.unit.name})`
  const on = businessDate(now, workOrder.property.timezone)

  const task = {
    propertyId: workOrder.propertyId,
    subjectType: 'WorkOrder' as const,
    subjectId: workOrder.id,
    businessDate: on,
  }

  switch (event.kind) {
    case 'declined': {
      await createTask(prisma, {
        ...task,
        // REUSES the no-response type rather than inventing a second one.
        // The work is identical - pick somebody else off the fallback list -
        // and a queue with `workorder_redispatch` and
        // `workorder_declined_redispatch` in it makes a PM decide which list
        // to read. The title says which happened.
        type: 'workorder_redispatch',
        // Carries the JOB's priority, unlike the ready-to-close task. A
        // declined emergency is still an emergency; nothing has been fixed.
        priority: workOrder.priority,
        title: `${vendorName} declined — re-dispatch: ${where}`,
      })
      await notifyStaff(workOrder, 'vendor.declined', {
        vendorName,
        scope: workOrder.scope,
        unitName: workOrder.unit.name,
        propertyName: workOrder.property.name,
        priority: workOrder.priority,
        declineReason: event.declineReason,
      })
      return
    }

    case 'accepted':
    case 'proposed_time': {
      // ACCEPTING IS NOT SCHEDULING - R-027 owns confirming a window with the
      // entry-notice check, and `respondToWorkOrder` deliberately leaves an
      // accepted job ASSIGNED. That gap is real work, and until now nothing
      // represented it: an accepted job with no confirmed window looked
      // identical to one nobody had touched.
      //
      // A proposed time is the same task with a different sentence. The
      // vendor has offered a window somebody has to say yes or no to, and
      // because they HAVE responded the no-response sweep steps over them
      // too - the second silent hole this item closes.
      await createTask(prisma, {
        ...task,
        type: 'workorder_schedule',
        priority: workOrder.priority,
        title:
          event.kind === 'accepted'
            ? `${vendorName} accepted — confirm a window: ${where}`
            : `${vendorName} proposed a time — confirm or counter: ${where}`,
      })
      return
    }

    case 'message': {
      const preview = event.body.trim().replace(/\s+/g, ' ').slice(0, 140)
      await createTask(prisma, {
        ...task,
        type: 'workorder_vendor_message',
        // ROUTINE whatever the job is. A question about an emergency is not
        // itself an emergency, and paging on every vendor message is how the
        // urgent queue stops being read.
        priority: 'ROUTINE',
        title: `${vendorName} asked something: ${preview.slice(0, 60)}`,
      })
      await notifyStaff(workOrder, 'vendor.message', {
        vendorName,
        scope: workOrder.scope,
        unitName: workOrder.unit.name,
        preview,
      })
      return
    }

    case 'invoice': {
      // Only when the invoice did NOT trip the ceiling. An over-ceiling
      // invoice already moves the work order to PENDING_APPROVAL, which
      // R-026 surfaces as an approval of its own - raising a second task
      // beside it would have two queue rows for one decision.
      if (event.overCeiling) return
      await createTask(prisma, {
        ...task,
        type: 'workorder_invoice_review',
        priority: 'ROUTINE',
        title: `Invoice from ${vendorName}: ${where}`,
      })
      return
    }
  }
}

async function notifyStaff(
  workOrder: FollowUpWorkOrder,
  templateKey: 'vendor.declined' | 'vendor.message',
  context: Record<string, unknown>,
): Promise<void> {
  // `workorder.write`, not `unit.write`. The people who should hear that a
  // vendor said no are the people who can send the job to somebody else.
  const recipients = await staffForProperty(workOrder.propertyId, 'workorder.write')
  for (const staff of recipients) {
    await notify({
      category: 'vendor_response',
      templateKey,
      recipient: { type: 'STAFF', id: staff.id, email: staff.email, phone: staff.phone },
      context,
      propertyId: workOrder.propertyId,
      // Keyed on the work order, the template AND the day. A vendor who
      // sends three messages in an afternoon should produce three
      // notifications, so the message key carries a timestamp; a decline can
      // only happen once per job, so it does not.
      idempotencyKey:
        templateKey === 'vendor.declined'
          ? `vendor-declined:${workOrder.id}:${staff.id}`
          : `vendor-message:${workOrder.id}:${staff.id}:${Date.now()}`,
    })
  }
}
