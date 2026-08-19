import 'server-only'

import { earliestCompliantStart } from '@rental/core/entry'
import { availableShowingSlots } from '@rental/core/scheduling'
import { type Showing, prisma } from '@rental/db'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// Reads for Showing (LEASE-08, R-064).

/**
 * Every open slot for a listing's unit, right now.
 *
 * Shared between the booking page (to display the list) and the booking
 * action (to re-validate the submitted choice at write time) - the same
 * split `entryContextFor()` gives `scheduleEntry()`, so the two can never
 * quietly disagree about what counts as a valid slot.
 */
export async function availableSlotsFor(
  unit: { id: string; status: string },
  property: { state: string; county: string | null; timezone: string },
  now: Date,
): Promise<Date[]> {
  const booked = await prisma.showing.findMany({
    where: { unitId: unit.id, status: 'BOOKED', scheduledStart: { gte: now } },
    select: { scheduledStart: true },
  })

  let earliestStart: Date | null = null
  if (unit.status === 'OCCUPIED') {
    const rule = await rulesFor({ state: property.state, county: property.county }, now)
    earliestStart = earliestCompliantStart(now, rule.entryNoticeHours)
  }

  return availableShowingSlots({
    now,
    timezone: property.timezone,
    bookedStarts: booked.map((b) => b.scheduledStart),
    earliestStart,
  })
}

export async function showingsForProspect(prospectId: string): Promise<
  (Showing & { unit: { name: string }; property: { timezone: string } })[]
> {
  return prisma.showing.findMany({
    where: { prospectId },
    orderBy: { scheduledStart: 'desc' },
    include: { unit: { select: { name: true } }, property: { select: { timezone: true } } },
  })
}
