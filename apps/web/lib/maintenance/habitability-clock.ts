import 'server-only'

import { type HabitabilityRepairClock, habitabilityRepairClock } from '@rental/core/maintenance'
import { type BusinessDate, businessDate } from '@rental/core/scheduling'
import { type Prisma, prisma, TicketStatus, WorkOrderStatus } from '@rental/db'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// R-217: what "repaired" means for the habitability repair clock, shared by
// the stall sweep (lib/cases/case-stall-job.ts) and the ticket page so the
// two can never disagree about whether the clock is still running.
//
// A work order off the ticket at WORK_COMPLETE or later, or the ticket
// itself closed. CONVERTED is not repaired - that is the no-heat ticket with
// a vendor booked for Tuesday.
//
// MERGED IS NOT STOPPED. A flagged duplicate merged into a survivor keeps its
// own clock, because it carries the EARLIER complaint date and the survivor
// may not be flagged at all - stopping it would let a merge silently end the
// one clock that runs against the owner. It stops when the survivor is
// repaired or closed.
export const REPAIRED_WORK_ORDER_STATUSES = [
  WorkOrderStatus.WORK_COMPLETE,
  WorkOrderStatus.VERIFIED,
  WorkOrderStatus.INVOICED,
  WorkOrderStatus.CLOSED,
]

const resolved = {
  OR: [
    { status: TicketStatus.CLOSED },
    { workOrders: { some: { status: { in: REPAIRED_WORK_ORDER_STATUSES } } } },
  ],
} satisfies Prisma.TicketWhereInput

/// Every flagged ticket whose repair clock is still running.
export const REPAIR_CLOCK_RUNNING = {
  habitabilityFlag: true,
  NOT: { OR: [resolved, { mergedInto: resolved }] },
} satisfies Prisma.TicketWhereInput

export type TicketRepairDeadline =
  | { kind: 'not_applicable' }
  | { kind: 'no_rule'; state: string }
  | { kind: 'running'; days: number; clock: HabitabilityRepairClock }

/// For the ticket page: the derived due date, or why there is none.
export async function repairDeadlineFor(ticketId: string, today: BusinessDate): Promise<TicketRepairDeadline> {
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, ...REPAIR_CLOCK_RUNNING },
    select: {
      createdAt: true,
      property: { select: { state: true, county: true, timezone: true } },
    },
  })
  if (!ticket) return { kind: 'not_applicable' }
  const rule = await rulesFor(ticket.property, new Date()).catch(() => null)
  const clock = habitabilityRepairClock(
    businessDate(ticket.createdAt, ticket.property.timezone),
    rule?.habitabilityRepairDays ?? null,
    rule ?? { dayCountBasis: null, observedHolidays: [] },
    today,
  )
  if (!rule || !clock) return { kind: 'no_rule', state: ticket.property.state }
  return { kind: 'running', days: rule.habitabilityRepairDays!, clock }
}
