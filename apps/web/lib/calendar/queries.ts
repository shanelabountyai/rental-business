import 'server-only'

import type { CalendarEvent } from '@rental/core/scheduling'
import { prisma } from '@rental/db'

// The visits behind a staff calendar feed (NOTIF-06, R-097c).
//
// ==========================================================================
// WHAT GOES INTO A THIRD PARTY'S CALENDAR IS A DISCLOSURE DECISION, and this
// file is where it is made. A subscribed feed ends up on a phone, in a
// desktop client, and inside whichever cloud calendar the staff member uses -
// three copies this product does not control, with their own sharing
// features and their own retention.
//
// So the feed carries WHERE, WHEN and WHAT KIND OF VISIT, and stops:
//
//   * NO TENANT NAME, no phone, no email. Somebody standing outside a door
//     needs the address and the time; they have the app for the rest, and a
//     tenant's contact details in a shared work calendar is a disclosure
//     nobody consented to.
//   * NO `WorkOrder.restrictedPartyNote` - R-091 puts a household member's
//     name in that column for a locksmith standing at a door, and D-107 is
//     what says it goes no further. The JOB appears, because D-109 is
//     explicit that a confidential case's consequences cannot be hidden and
//     a re-key is an ordinary visit somebody has to attend.
//   * NO WORK-ORDER SCOPE, for a subtler reason: a scope line is written by
//     whoever raised the job and can say anything at all, including things
//     about a household. A closed vocabulary of visit KINDS cannot.
//
// `calendar.test.ts` greps this file for both column names, the same
// source-level guard R-092's export carries and for the same reason: the
// output can never catch a query that starts selecting one more field.
// ==========================================================================

/// Far enough back that this morning's visit is still on the calendar after
/// it happened, far enough forward to be the whole plannable horizon.
const LOOK_BACK_DAYS = 7
const LOOK_AHEAD_DAYS = 90

export interface FeedWindow {
  from: Date
  to: Date
}

export function feedWindow(now: Date): FeedWindow {
  return {
    from: new Date(now.getTime() - LOOK_BACK_DAYS * 24 * 60 * 60_000),
    to: new Date(now.getTime() + LOOK_AHEAD_DAYS * 24 * 60 * 60_000),
  }
}

/// Half an hour, where a source records a start and no end. A zero-length
/// event renders as a sliver a phone will not show; guessing an hour would
/// block out time nobody agreed to.
const DEFAULT_MINUTES = 30

function address(property: {
  addressLine1: string
  city: string
  state: string
  postalCode: string
}) {
  return `${property.addressLine1}, ${property.city}, ${property.state} ${property.postalCode}`
}

export async function calendarEventsFor(
  propertyIds: readonly string[],
  window: FeedWindow,
): Promise<CalendarEvent[]> {
  if (propertyIds.length === 0) return []
  const scope = { in: [...propertyIds] }
  const propertySelect = {
    select: { addressLine1: true, city: true, state: true, postalCode: true },
  } as const

  const [showings, inspections, workOrders] = await Promise.all([
    prisma.showing.findMany({
      where: {
        propertyId: scope,
        status: 'BOOKED',
        scheduledStart: { gte: window.from, lte: window.to },
      },
      select: {
        id: true,
        scheduledStart: true,
        scheduledEnd: true,
        unit: { select: { name: true } },
        property: propertySelect,
      },
    }),
    prisma.inspection.findMany({
      where: { propertyId: scope, scheduledFor: { gte: window.from, lte: window.to } },
      select: {
        id: true,
        type: true,
        scheduledFor: true,
        unit: { select: { name: true } },
        property: propertySelect,
      },
    }),
    // NO scope field selected, and no restricted-party note. See the header:
    // a work-order description is free text somebody typed, and this feed
    // leaves the building.
    prisma.workOrder.findMany({
      where: {
        propertyId: scope,
        scheduledStart: { gte: window.from, lte: window.to },
        status: { notIn: ['CLOSED', 'CANCELED'] },
      },
      select: {
        id: true,
        scheduledStart: true,
        scheduledEnd: true,
        priority: true,
        unit: { select: { name: true } },
        property: propertySelect,
      },
    }),
  ])

  const events: CalendarEvent[] = []

  for (const showing of showings) {
    events.push({
      uid: `showing-${showing.id}@rental-operations`,
      start: showing.scheduledStart,
      end: showing.scheduledEnd,
      summary: `Showing — ${showing.unit.name}`,
      location: address(showing.property),
      description: 'A prospective tenant is viewing this unit.',
    })
  }

  for (const inspection of inspections) {
    if (!inspection.scheduledFor) continue
    events.push({
      uid: `inspection-${inspection.id}@rental-operations`,
      start: inspection.scheduledFor,
      end: new Date(inspection.scheduledFor.getTime() + DEFAULT_MINUTES * 60_000),
      // The TYPE, from a closed enum - never a free-text note. Move-in,
      // move-out, periodic: enough to know what to bring.
      summary: `${inspection.type.toLowerCase().replace(/_/g, ' ')} inspection — ${inspection.unit.name}`,
      location: address(inspection.property),
      description: 'Inspection. The full checklist is in the app.',
    })
  }

  for (const job of workOrders) {
    if (!job.scheduledStart) continue
    events.push({
      uid: `workorder-${job.id}@rental-operations`,
      start: job.scheduledStart,
      end: job.scheduledEnd ?? new Date(job.scheduledStart.getTime() + DEFAULT_MINUTES * 60_000),
      // Priority, not description. "Urgent maintenance" tells somebody what
      // they need to know; the job's own words do not belong in a calendar
      // that leaves the building.
      summary: `${job.priority.toLowerCase()} maintenance — ${job.unit?.name ?? 'property'}`,
      location: address(job.property),
      description: 'A maintenance visit. Open the work order in the app for what it is.',
    })
  }

  return events.sort((a, b) => a.start.getTime() - b.start.getTime())
}
