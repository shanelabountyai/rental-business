import 'server-only'

import { prisma } from '@rental/db'
import { CONSUMERS } from '@/lib/jobs/outbox.ts'
import { notify } from './send.ts'

// Event -> notification wiring (NOTIF-01: "all modules emit events into one
// notification engine").
//
// R-006 shipped CONSUMERS empty and named this item as one of the things that
// would fill it. Registering here rather than in each emitting module is the
// point of an event bus: R-009's auto-make-ready job knows nothing about
// notifications, and adding a second reaction to the same fact later does not
// touch it.
//
// Every consumer here calls `notify()` with the dispatcher's own transaction,
// so the notification and the EventConsumption row that marks the event
// handled commit together. A consumer that fails midway is retried and, on
// retry, `notify()`'s idempotency key refuses the duplicate - the two
// guarantees are stacked deliberately, because either alone leaves a way to
// text somebody twice.

/**
 * A unit went to make-ready with no renewal in place (PROP-02, R-009). Told to
 * the staff who can act on it, since a turn that nobody schedules is vacancy
 * nobody is measuring.
 *
 * Recipients are staff with `unit.write` on the property, resolved at send
 * time rather than stored: who should hear about a property changes with
 * assignments, and a subscriber list copied at registration time goes stale
 * silently.
 */
CONSUMERS.push({
  name: 'notify-unit-make-ready',
  event: 'unit.became_make_ready',
  handle: async (tx, event) => {
    if (!event.propertyId) return

    const unit = await tx.unit.findUnique({
      where: { id: event.aggregateId },
      select: { name: true, property: { select: { name: true } } },
    })
    if (!unit) return

    const recipients = await staffForProperty(event.propertyId)
    for (const staff of recipients) {
      await notify(
        {
          category: 'unit_make_ready',
          templateKey: 'unit.make_ready',
          recipient: {
            type: 'STAFF',
            id: staff.id,
            email: staff.email,
          },
          context: {
            propertyName: unit.property.name,
            unitName: unit.name,
          },
          propertyId: event.propertyId,
          eventId: event.id,
          // The event id, not the unit id: the same unit can legitimately go
          // make-ready again after a later tenancy, and that is a new fact
          // deserving a new notification. Keying on the unit alone would send
          // the first one and silently swallow every one after it.
          idempotencyKey: `unit-make-ready:${event.id}:${staff.id}`,
        },
        tx,
      )
    }
  },
})

/**
 * Staff who hold `unit.write` over a property, through any live assignment -
 * portfolio-wide, entity-scoped, or on the property itself.
 *
 * Deliberately reads assignments rather than calling R-004's `can()`: `can()`
 * answers for one actor, and this needs the inverse question ("who can?"),
 * which no permission check is shaped to answer. The permission key is the
 * same one the UI uses to decide whether to show unit controls, so the two
 * stay in step.
 */
/**
 * Staff who hold a permission over a property, through any live assignment.
 *
 * `permission` is a parameter because "who should hear about this" differs by
 * subject: a unit going make-ready is for whoever maintains units, and a
 * vendor declining a job is for whoever dispatches them (R-032a). Exported
 * for the same reason - a second copy of this query would drift from this one
 * the first time the assignment shape changes.
 *
 * Returns `phone` as well as `email`: a template with an SMS channel gets a
 * SUPPRESSED row rather than a send when the address is missing, so omitting
 * the column silently downgrades every SMS-carrying notification to email.
 */
export async function staffForProperty(propertyId: string, permission = 'unit.write') {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { legalEntityId: true },
  })
  if (!property) return []

  const assignments = await prisma.staffAssignment.findMany({
    where: {
      revokedAt: null,
      staffUser: { active: true },
      role: { permissions: { has: permission } },
      OR: [
        { propertyId: null, legalEntityId: null },
        { legalEntityId: property.legalEntityId },
        { propertyId },
      ],
    },
    select: { staffUser: { select: { id: true, email: true, phone: true } } },
  })

  // One assignment each, however many grants reach them - two roles over the
  // same property must not mean two emails.
  const byId = new Map<string, { id: string; email: string; phone: string | null }>()
  for (const assignment of assignments) {
    byId.set(assignment.staffUser.id, assignment.staffUser)
  }
  return [...byId.values()]
}
