import 'server-only'

import { CATEGORY_LABELS, type MaintenanceCategory } from '@rental/core/maintenance'
import { businessDate } from '@rental/core/scheduling'
import { CONSUMERS } from '@/lib/jobs/outbox.ts'
import { createTask } from '@/lib/tasks/create.ts'

// Every new Ticket becomes a Task in the ONE staff queue (D-9, MAINT-02,
// R-023) - "Triage queue as a Task view" is the backlog's own phrase for
// this. Reacting to the event rather than creating the Task inline at each
// of the four ticket-creation sites (portal, SMS, phone-logged, emergency)
// is the same call R-016's own consumer made for unit.became_make_ready: one
// reaction, registered once, that none of the four intake paths needs to
// know exists.
//
// ponytail: delivery is the hourly cron's, same as everything else through
// this bus (R-006's own "fine for nightly work, not fine for an emergency"
// framing) - so a triage Task can lag its Ticket by up to an hour. The
// Ticket itself is never hidden in the meantime; it is already live on
// /maintenance the instant it is created (R-022). A genuine emergency never
// arrives this way at all - R-020's own intake pages on-call directly, in
// the same request, bypassing this bus entirely.

CONSUMERS.push({
  name: 'create-ticket-triage-task',
  event: 'ticket.created',
  handle: async (tx, event) => {
    const ticket = await tx.ticket.findUnique({
      where: { id: event.aggregateId },
      select: {
        id: true,
        propertyId: true,
        unitId: true,
        category: true,
        priority: true,
        habitabilityFlag: true,
        status: true,
        property: { select: { timezone: true } },
        unit: { select: { name: true } },
      },
    })
    // Gone already (a same-second merge, an unlikely race) - nothing to
    // triage.
    if (!ticket) return
    // TRIAGED or later means a human already acted before this ever ran
    // (the hourly lag above makes this the normal case, not the exception,
    // once R-023's own UI lets an override happen inside that hour) -
    // creating a task for it now would put a stale suggestion in front of a
    // PM who has already moved past it.
    if (ticket.status !== 'NEW') return

    const categoryLabel =
      CATEGORY_LABELS[ticket.category as MaintenanceCategory] ?? 'Uncategorized'
    const title = ticket.habitabilityFlag
      ? `Habitability: ${categoryLabel} — ${ticket.unit.name}`
      : `Triage: ${categoryLabel} — ${ticket.unit.name}`

    await createTask(tx, {
      propertyId: ticket.propertyId,
      type: 'ticket_triage',
      subjectType: 'Ticket',
      subjectId: ticket.id,
      businessDate: businessDate(event.occurredAt, ticket.property.timezone),
      priority: ticket.priority,
      title,
    })
  },
})
