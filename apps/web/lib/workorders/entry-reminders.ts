import 'server-only'

import { prisma } from '@rental/db'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// The T-1-day entry reminder (MAINT-05: "the tenant is notified with
// reminders at T-1 day").
//
// Hourly from the cron tick, NOT a SCHEDULED_JOBS entry, for the same reason
// R-025's no-response sweep is: this measures a fixed distance in HOURS from
// a scheduled instant, which is the same duration everywhere, rather than
// answering a calendar-day question that would need each property's local
// midnight. A daily job would also fire at an arbitrary hour relative to the
// visit - "tomorrow" sent at 3am is not a reminder anybody reads.

/// The window a visit has to fall into to be reminded on this tick. 24 hours
/// out, give or take the tick interval - wide enough that an hourly cron
/// cannot skip a visit between runs, and `notify()`'s own idempotency key
/// (below) is what stops the overlap sending twice.
const REMINDER_LEAD_HOURS = 24
const WINDOW_HOURS = 1.5

export interface ReminderSweepResult {
  checked: number
  reminded: number
}

export async function sweepEntryReminders(
  now = new Date(),
): Promise<ReminderSweepResult> {
  const from = new Date(now.getTime() + (REMINDER_LEAD_HOURS - WINDOW_HOURS) * 3_600_000)
  const to = new Date(now.getTime() + REMINDER_LEAD_HOURS * 3_600_000)

  const upcoming = await prisma.workOrder.findMany({
    where: {
      scheduledStart: { gte: from, lte: to },
      status: { in: ['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS'] },
    },
    select: {
      id: true,
      propertyId: true,
      scheduledStart: true,
      scheduledEnd: true,
      scope: true,
      property: { select: { addressLine1: true, timezone: true } },
      unit: { select: { name: true } },
      ticket: {
        select: {
          tenant: { select: { id: true, firstName: true, email: true, phone: true } },
        },
      },
    },
  })

  const deliveryIds: string[] = []
  let reminded = 0

  for (const workOrder of upcoming) {
    const tenant = workOrder.ticket?.tenant
    if (!tenant || !workOrder.scheduledStart || !workOrder.scheduledEnd) continue

    try {
      const outcomes = await notify({
        category: 'entry_notice',
        templateKey: 'entry.notice',
        recipient: { type: 'TENANT', id: tenant.id, email: tenant.email, phone: tenant.phone },
        context: {
          tenantName: tenant.firstName,
          addressLine1: workOrder.property.addressLine1,
          unitName: workOrder.unit.name,
          scheduledStart: workOrder.scheduledStart.toISOString(),
          scheduledEnd: workOrder.scheduledEnd.toISOString(),
          timezone: workOrder.property.timezone,
          reason: workOrder.scope,
          isReminder: true,
        },
        propertyId: workOrder.propertyId,
        // Keyed on the WINDOW, so the overlapping sweep above sends exactly
        // one reminder per scheduled visit - and a rescheduled visit gets a
        // fresh reminder because its start time changed.
        idempotencyKey: `entry-reminder:${workOrder.id}:${workOrder.scheduledStart.getTime()}`,
      })
      for (const outcome of outcomes) {
        if (outcome.deliveryId) deliveryIds.push(outcome.deliveryId)
        if (outcome.outcome === 'recorded') reminded += 1
      }
    } catch (error) {
      console.error(`[entry] reminder failed for work order ${workOrder.id}`, error)
    }
  }

  // Only what this sweep queued - see dispatchPendingNotifications' `only`.
  await dispatchPendingNotifications(now, 100, { deliveryIds }).catch(() => {})

  return { checked: upcoming.length, reminded }
}
