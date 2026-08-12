import 'server-only'

import { EMERGENCY_DEFINITIONS, isEmergencyCategory } from '@rental/core/maintenance'
import { minutesUnacknowledged, shouldEscalate } from '@rental/core/oncall'
// Imported from system.ts directly, NOT the audit barrel: index.ts pulls in
// Auth.js to resolve a session, and this sweep runs from a cron with nobody
// signed in - see that module's own header.
import { auditAsSystem } from '@/lib/audit/system.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import {
  alreadyEscalatedTicketIds,
  emergencyPagingPlan,
  unacknowledgedEmergencies,
} from './emergency.ts'

// The escalation chain (NOTIF-05: "emergency ticket unacknowledged 15 min →
// escalate past on-call to owner", R-029).
//
// RUNS EVERY FIVE MINUTES, from its own cron entry rather than the hourly one
// (vercel.json). Fifteen minutes cannot be detected by an hourly tick - an
// emergency reported at 09:05 would escalate at 10:00, fifty-five minutes
// after the deadline the requirement names. Everything else in the hourly job
// measures days; this measures the window in which somebody is still standing
// in the water.
//
// "Escalate once" has no column behind it. Every send is keyed on (ticket,
// recipient) through the same notification idempotency the rest of the
// product uses, so a re-evaluated emergency could not double-page even if
// this sweep tried; and `alreadyEscalatedTicketIds()` reads that same record
// up front so it does not try. A `lastEscalatedAt` column would be a second,
// weaker copy of a fact the sends already carry.

export interface EscalationSweep {
  checked: number
  escalated: number
}

export async function sweepEmergencyEscalations(
  now = new Date(),
  /// Narrows the sweep to specific tickets (R-102b). See
  /// `unacknowledgedEmergencies` for why this exists; the cron passes nothing.
  only?: { ticketIds: readonly string[] },
): Promise<EscalationSweep> {
  const open = await unacknowledgedEmergencies(now, only)
  const due = open.filter((ticket) => shouldEscalate(ticket, now))
  // One query, not one per tick per ticket forever - see
  // alreadyEscalatedTicketIds() for why this is not a `lastEscalatedAt`
  // column.
  const alreadySent = await alreadyEscalatedTicketIds(due.map((t) => t.id))

  let escalated = 0
  const deliveryIds: string[] = []

  for (const ticket of due) {
    if (alreadySent.has(ticket.id)) continue

    const plan = await emergencyPagingPlan(ticket.propertyId, now)
    // Nobody on call means the first page already reached everybody with
    // authority over the property, so there is no one further up to reach.
    // Page the same people again rather than doing nothing: the requirement
    // is that an unanswered emergency gets louder, and silence because the
    // rota was never set up is exactly the case that needs the second page.
    const repage = plan.escalationChain.length === 0
    const recipients = repage ? plan.recipients : plan.escalationChain
    if (recipients.length === 0) continue

    const minutes = minutesUnacknowledged(ticket, now)
    const label = isEmergencyCategory(ticket.category)
      ? EMERGENCY_DEFINITIONS[ticket.category].label
      : ticket.category

    const sends = await Promise.allSettled(
      recipients.map((staff) =>
        notify({
          category: 'maintenance_emergency',
          templateKey: 'maintenance.emergency_escalation',
          recipient: {
            type: 'STAFF',
            id: staff.id,
            email: staff.email,
            phone: staff.phone,
          },
          context: {
            emergencyLabel: label,
            propertyName: ticket.property.name,
            addressLine1: ticket.property.addressLine1,
            unitName: ticket.unit?.name ?? '',
            tenantName: ticket.tenant
              ? `${ticket.tenant.firstName} ${ticket.tenant.lastName}`
              : 'the reporter',
            tenantPhone: ticket.tenant?.phone ?? null,
            petWarning: false,
            entryPermission: false,
            minutesUnacknowledged: minutes,
            repage,
          },
          propertyId: ticket.propertyId,
          // The idempotency that makes "escalate once" true without a column.
          idempotencyKey: `emergency-escalation:${ticket.id}:${staff.id}`,
          now,
        }),
      ),
    )

    let wrote = false
    for (const send of sends) {
      if (send.status === 'rejected') {
        console.error(`[escalation] page failed for ${ticket.id}`, send.reason)
        continue
      }
      for (const outcome of send.value) {
        if (outcome.outcome === 'recorded') wrote = true
        if (outcome.deliveryId) deliveryIds.push(outcome.deliveryId)
      }
    }

    // Only count and record an escalation that actually wrote something. A
    // re-evaluated ticket whose sends all deduplicated has not escalated
    // again, and an audit trail claiming it did would be a lie about who was
    // told what, when.
    if (!wrote) continue
    escalated += 1
    await auditAsSystem('escalation', {
      action: 'ticket.escalated',
      entityType: 'Ticket',
      entityId: ticket.id,
      propertyId: ticket.propertyId,
      after: {
        minutesUnacknowledged: minutes,
        basis: plan.basis,
        repage,
        recipientIds: recipients.map((staff) => staff.id),
      },
    }).catch((error) => {
      // The pages are already out. An audit failure must not make the sweep
      // look like it did nothing.
      console.error(`[escalation] audit failed for ${ticket.id}`, error)
    })
  }

  // Same reason R-020's emergency page flushes its own ids: an escalation
  // that sits in the queue until the hourly dispatch has escalated nothing.
  if (deliveryIds.length > 0) {
    await dispatchPendingNotifications(now, 200, { deliveryIds })
  }

  return { checked: open.length, escalated }
}
