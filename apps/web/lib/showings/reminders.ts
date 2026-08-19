import 'server-only'

import { prisma } from '@rental/db'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// The T-1-day / T-2-hour showing reminders (LEASE-08: "SMS reminders send -
// no-show reduction"). Same shape as workorders/entry-reminders.ts's own
// `sweepEntryReminders()` - hourly from the cron tick, not a SCHEDULED_JOBS
// entry, because this measures a fixed distance in hours from a scheduled
// instant rather than a calendar-day question. ONE function covering both
// leads, unlike that file's single lead, since the two sweeps are otherwise
// identical and a second cron-route call for the near-duplicate would just
// be more wiring for the same idea.

interface ReminderLead {
  hours: number
  windowHours: number
  key: string
}

const REMINDER_LEADS: readonly ReminderLead[] = [
  { hours: 24, windowHours: 1.5, key: '24h' },
  { hours: 2, windowHours: 0.5, key: '2h' },
]

export interface ShowingReminderSweepResult {
  checked: number
  reminded: number
}

export async function sweepShowingReminders(
  now = new Date(),
): Promise<ShowingReminderSweepResult> {
  let checked = 0
  let reminded = 0
  const deliveryIds: string[] = []

  for (const lead of REMINDER_LEADS) {
    const from = new Date(now.getTime() + (lead.hours - lead.windowHours) * 3_600_000)
    const to = new Date(now.getTime() + lead.hours * 3_600_000)

    const upcoming = await prisma.showing.findMany({
      where: { status: 'BOOKED', scheduledStart: { gte: from, lte: to } },
      select: {
        id: true,
        propertyId: true,
        scheduledStart: true,
        scheduledEnd: true,
        prospect: { select: { id: true, firstName: true, email: true, phone: true } },
        unit: { select: { name: true } },
        property: { select: { addressLine1: true, timezone: true } },
      },
    })
    checked += upcoming.length

    for (const showing of upcoming) {
      try {
        const outcomes = await notify({
          category: 'prospect_showing',
          templateKey: 'showing.scheduled',
          recipient: {
            type: 'PROSPECT',
            id: showing.prospect.id,
            email: showing.prospect.email,
            phone: showing.prospect.phone,
          },
          context: {
            firstName: showing.prospect.firstName,
            addressLine1: showing.property.addressLine1,
            unitName: showing.unit.name,
            scheduledStart: showing.scheduledStart.toISOString(),
            scheduledEnd: showing.scheduledEnd.toISOString(),
            timezone: showing.property.timezone,
            isReminder: true,
          },
          propertyId: showing.propertyId,
          // Keyed on the lead AND the window, so the 24h and 2h sweeps never
          // collide and an overlapping tick sends at most one of each.
          idempotencyKey: `showing-reminder-${lead.key}:${showing.id}`,
        })
        for (const outcome of outcomes) {
          if (outcome.deliveryId) deliveryIds.push(outcome.deliveryId)
          if (outcome.outcome === 'recorded') reminded += 1
        }
      } catch (error) {
        console.error(`[showings] reminder failed for showing ${showing.id}`, error)
      }
    }
  }

  await dispatchPendingNotifications(now, 100, { deliveryIds }).catch(() => {})
  return { checked, reminded }
}
