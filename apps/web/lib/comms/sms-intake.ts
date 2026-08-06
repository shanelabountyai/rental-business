import 'server-only'

import {
  decideSmsIntake,
  formatSmsTicketDescription,
  isOpenTicketStatus,
} from '@rental/core/comms'
import { detectHabitabilityLanguage, suggestTicketPriority } from '@rental/core/maintenance'
import { prisma } from '@rental/db'
// From system.ts, not index.ts: index pulls in Auth.js, and a webhook has no
// session by definition. See system.ts's own comment.
import { auditAsSystem } from '@/lib/audit/system.ts'
import { emitEvent } from '@/lib/jobs/outbox.ts'
import { receiveInboundMessage } from './messages.ts'

// SMS-to-ticket (MAINT-01, COMM-01, R-021).
//
// Built ON TOP of R-017's `receiveInboundMessage` rather than beside it: the
// routing decision (whose conversation is this? refuse to guess) is already
// solved and already the most safety-critical part of inbound handling. This
// adds one thing on top - if the text routed to a TENANT and they have
// nothing open, open a maintenance ticket.

export type SmsIntakeResult =
  | { outcome: 'duplicate' }
  | { outcome: 'unrouted'; reason: string }
  | { outcome: 'threaded'; threadId: string; existingTicketId?: string }
  | { outcome: 'ticket_opened'; threadId: string; ticketId: string }

/**
 * Handles one inbound text end to end.
 *
 * Order matters: the message is threaded FIRST (R-017), and only then does a
 * ticket get considered. A text that cannot be routed - unknown number,
 * several matches - never opens a ticket at all, because a ticket has to
 * belong to a property and a tenant, and inventing either is exactly what
 * `decideRoute` refuses to do. It lands in the unrouted queue for a human,
 * and whoever files it can open a ticket then.
 */
export async function handleInboundSms(args: {
  from: string
  body: string
  receivedAt: Date
  externalId?: string | null
}): Promise<SmsIntakeResult> {
  const routed = await receiveInboundMessage({
    channel: 'SMS',
    from: args.from,
    body: args.body,
    receivedAt: args.receivedAt,
    externalId: args.externalId,
  })

  if (routed.outcome === 'duplicate') return { outcome: 'duplicate' }
  if (routed.outcome === 'unrouted') {
    return { outcome: 'unrouted', reason: routed.reason }
  }

  const thread = await prisma.thread.findUniqueOrThrow({
    where: { id: routed.threadId },
    select: { id: true, propertyId: true, tenantId: true },
  })

  // Vendors text too (R-025's magic-link work orders), and their messages
  // thread perfectly well - but a vendor saying "running late" is not a
  // maintenance request from a tenant, and opening a ticket in their name
  // would be nonsense.
  if (!thread.tenantId) return { outcome: 'threaded', threadId: thread.id }

  const openTickets = await prisma.ticket.findMany({
    where: { tenantId: thread.tenantId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  })
  const decision = decideSmsIntake(openTickets)

  if (decision.outcome === 'thread_only') {
    return {
      outcome: 'threaded',
      threadId: thread.id,
      existingTicketId: decision.existingTicketId,
    }
  }

  // The tenant's current unit, for the ticket's own scope. Read from the
  // thread's property rather than re-deriving from the tenant, so the ticket
  // and the conversation cannot end up pointing at different homes.
  const leaseTenant = await prisma.leaseTenant.findFirst({
    where: {
      tenantId: thread.tenantId,
      lease: { propertyId: thread.propertyId },
    },
    orderBy: { lease: { startsOn: 'desc' } },
    select: { lease: { select: { id: true, unitId: true } } },
  })
  if (!leaseTenant) {
    // Routed to a tenant thread but no lease at that property - possible
    // only if a lease was removed between routing and here. Threaded, no
    // ticket: a Ticket needs a unit, and inventing one is worse than not
    // opening it.
    return { outcome: 'threaded', threadId: thread.id }
  }

  const description = formatSmsTicketDescription(args.body)
  // The same keyword scan R-019 runs, against the tenant's own words. A text
  // saying "there's mold in the bathroom" has to start the response clock
  // exactly as the portal version would (MAINT-02, RISK-05).
  const habitabilityFlag = detectHabitabilityLanguage(args.body)
  // Category is UNCATEGORIZED, so the priority suggestion is weak evidence
  // built from habitability alone here - same function, same "PM can always
  // override" contract as every other intake path (R-023).
  const priority = suggestTicketPriority({ category: 'UNCATEGORIZED', habitabilityFlag })

  const ticket = await prisma.$transaction(async (tx) => {
    const created = await tx.ticket.create({
      data: {
        propertyId: thread.propertyId,
        unitId: leaseTenant.lease.unitId,
        leaseId: leaseTenant.lease.id,
        tenantId: thread.tenantId,
        source: 'SMS',
        // No category. R-019's structured intake earns one by ASKING; a text
        // has answered nothing, and a keyword guess would put a wrong label
        // on the one path with no clarifying prompts to correct it. R-023's
        // triage assigns it from a human reading the words.
        category: 'UNCATEGORIZED',
        description,
        priority,
        habitabilityFlag,
      },
    })
    // SYSTEM, not a staff actor: nobody was signed in. `ref` names the
    // webhook so an entry traces back to what produced it.
    await auditAsSystem(
      'sms-webhook',
      {
        action: 'ticket.submitted',
        entityType: 'Ticket',
        entityId: created.id,
        propertyId: thread.propertyId,
        after: { source: 'SMS', habitabilityFlag: created.habitabilityFlag },
      },
      tx,
    )
    await emitEvent(tx, {
      type: 'ticket.created',
      aggregateType: 'Ticket',
      aggregateId: created.id,
      propertyId: thread.propertyId,
      payload: { source: 'SMS' },
    })
    return created
  })

  return { outcome: 'ticket_opened', threadId: thread.id, ticketId: ticket.id }
}

export { isOpenTicketStatus }
