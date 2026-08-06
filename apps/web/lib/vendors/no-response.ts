import 'server-only'

import { businessDate } from '@rental/core/scheduling'
import { noResponseHoursFor, vendorHasNotResponded } from '@rental/core/vendors'
import { prisma } from '@rental/db'
import { createTask } from '@/lib/tasks/create.ts'

// The no-response timer (MAINT-03, R-025): "Given no vendor response in X
// hours, when the timer lapses, then the PM is prompted to re-dispatch to
// the next vendor on the trade's fallback list."
//
// NOT a SCHEDULED_JOBS entry, and the reason is D-3 read carefully rather
// than applied by reflex. Every job in SCHEDULED_JOBS runs once per property
// per LOCAL DAY at a chosen local hour, because those jobs answer
// calendar-day questions - "has the grace period elapsed", "did this lease
// end yesterday" - and a calendar day is a property-local fact. This one
// measures ELAPSED HOURS since a dispatch, which is the same duration in
// every timezone on earth. A daily job would also be useless for the thing
// it exists to catch: an emergency with a two-hour threshold cannot wait for
// tomorrow's 3am sweep.
//
// So it runs on every cron tick, beside dispatchOutbox() and
// dispatchPendingNotifications(), which are hourly for the same reason -
// they are about latency, not about dates.

export interface NoResponseSweepResult {
  checked: number
  prompted: number
}

/**
 * Raises a Task for every dispatched work order whose vendor has gone quiet
 * past its priority's threshold.
 *
 * A Task rather than a notification, deliberately: the answer to a silent
 * vendor is a PM DECIDING to re-dispatch and picking who from the fallback
 * list - that is work, and D-9 says work belongs in the one queue, not in a
 * notification that gets read and forgotten. R-016 can send a notification
 * ABOUT the task later without this having to change.
 *
 * `createTask()`'s own idempotency key is (type, subjectId, businessDate), so
 * an hourly sweep raises AT MOST ONE prompt per work order per day however
 * many times it runs - and raises a fresh one tomorrow if the vendor is
 * still silent, which is the right cadence for "you should chase this"
 * rather than either spamming hourly or going quiet forever after one ask.
 */
export async function sweepUnansweredDispatches(
  now = new Date(),
): Promise<NoResponseSweepResult> {
  // The partial index this query was written against
  // (WorkOrder_awaiting_vendor_response) covers exactly this shape: the rows
  // a vendor has already answered are the ones it never needs to look at.
  const candidates = await prisma.workOrder.findMany({
    where: {
      dispatchedAt: { not: null },
      vendorRespondedAt: null,
      vendorId: { not: null },
      status: { in: ['ASSIGNED', 'SCHEDULED'] },
    },
    select: {
      id: true,
      propertyId: true,
      priority: true,
      dispatchedAt: true,
      vendorRespondedAt: true,
      scope: true,
      property: { select: { timezone: true } },
      unit: { select: { name: true } },
      vendor: { select: { name: true } },
    },
  })

  let prompted = 0
  for (const workOrder of candidates) {
    if (!vendorHasNotResponded(workOrder, now)) continue

    const hours = noResponseHoursFor(workOrder.priority)
    const { created } = await createTask(prisma, {
      propertyId: workOrder.propertyId,
      type: 'workorder_redispatch',
      subjectType: 'WorkOrder',
      subjectId: workOrder.id,
      businessDate: businessDate(now, workOrder.property.timezone),
      priority: workOrder.priority,
      title: `No answer from ${workOrder.vendor?.name ?? 'the vendor'} in ${hours}h — re-dispatch: ${workOrder.scope.slice(0, 40)} (${workOrder.unit.name})`,
    })
    if (created) prompted += 1
  }

  return { checked: candidates.length, prompted }
}
