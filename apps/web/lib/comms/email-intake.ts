import 'server-only'

import {
  decideEmailIntake,
  formatEmailTicketDescription,
  isEmailOptOutRequest,
} from '@rental/core/comms'
import { detectHabitabilityLanguage, suggestTicketPriority } from '@rental/core/maintenance'
import { prisma } from '@rental/db'
// From system.ts, not index.ts: index pulls in Auth.js, and a webhook has no
// session by definition.
import { auditAsSystem } from '@/lib/audit/system.ts'
import { emitEvent } from '@/lib/jobs/outbox.ts'
import type { InboundAttachment } from './inbound-attachments.ts'
import { honourEmailOptOut } from './email-opt-out.ts'
import { receiveInboundMessage } from './messages.ts'

// Email-to-ticket (COMM-08, MAINT-01; R-097f).
//
// ==========================================================================
// THE SIBLING OF `sms-intake.ts`, AND DELIBERATELY THE SAME SHAPE. R-021
// built the pattern: thread first through `receiveInboundMessage`, then -
// and only then - consider a ticket. That ordering is not stylistic. A
// message that cannot be routed never opens a ticket at all, because a
// ticket has to belong to a property and a tenant, and inventing either is
// exactly what `decideRoute` refuses to do.
//
// THE ONE REAL DIFFERENCE IS THAT EMAIL IS A CONVERSATION. Nobody texts
// their property manager to say "thanks", so R-021 opens a ticket for any
// text from a tenant with nothing open. Applied verbatim to email, every
// "Thursday works" becomes a maintenance ticket and R-023's triage queue
// stops being real. `decideEmailIntake` answers it on EVIDENCE - a reply key,
// or recent outbound in the same conversation - rather than by guessing at
// the words, because guessing at intake is what this codebase already
// refuses one level down.
// ==========================================================================

export type EmailIntakeResult =
  | { outcome: 'duplicate' }
  | { outcome: 'unrouted'; reason: string }
  | { outcome: 'threaded'; threadId: string; existingTicketId?: string }
  | { outcome: 'ticket_opened'; threadId: string; ticketId: string }

export async function handleInboundEmail(args: {
  from: string
  body: string
  receivedAt: Date
  externalId?: string | null
  recipients?: readonly string[]
  attachments?: readonly InboundAttachment[]
  hasReplyKey: boolean
}): Promise<EmailIntakeResult> {
  const routed = await receiveInboundMessage({
    channel: 'EMAIL',
    from: args.from,
    body: args.body,
    receivedAt: args.receivedAt,
    externalId: args.externalId,
    recipients: args.recipients,
    attachments: args.attachments,
  })

  if (routed.outcome === 'duplicate') return { outcome: 'duplicate' }
  if (routed.outcome === 'unrouted') {
    return { outcome: 'unrouted', reason: routed.reason }
  }

  const thread = await prisma.thread.findUniqueOrThrow({
    where: { id: routed.threadId },
    select: { id: true, propertyId: true, tenantId: true, vendorId: true },
  })

  // R-097e. AFTER the message is filed and before any ticket: somebody
  // asking us to stop emailing is not reporting a repair, and opening a
  // maintenance ticket titled "please unsubscribe me" would be the visible
  // half of getting that wrong.
  if (isEmailOptOutRequest(args.body)) {
    if (thread.tenantId) await honourEmailOptOut('TENANT', thread.tenantId, args.from)
    else if (thread.vendorId) await honourEmailOptOut('VENDOR', thread.vendorId, args.from)
    return { outcome: 'threaded', threadId: thread.id }
  }

  // Vendors email too, and their messages thread perfectly well - but a
  // vendor saying "running late" is not a maintenance request from a tenant,
  // and opening a ticket in their name would be nonsense. R-021's own words.
  if (!thread.tenantId) return { outcome: 'threaded', threadId: thread.id }

  const [openTickets, lastOutbound] = await Promise.all([
    prisma.ticket.findMany({
      where: { tenantId: thread.tenantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    }),
    prisma.message.findFirst({
      where: { threadId: thread.id, direction: 'OUTBOUND' },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    }),
  ])

  const decision = decideEmailIntake(openTickets, {
    hasReplyKey: args.hasReplyKey,
    lastOutboundAt: lastOutbound?.sentAt ?? null,
    now: args.receivedAt,
  })

  if (decision.outcome === 'thread_only') {
    return {
      outcome: 'threaded',
      threadId: thread.id,
      // Empty where the reason was "this is a reply" rather than "they
      // already have one open" - the caller reports what it was told.
      existingTicketId: decision.existingTicketId || undefined,
    }
  }

  // The tenant's current unit, read from the THREAD's property rather than
  // re-derived from the tenant, so the ticket and the conversation cannot
  // end up pointing at different homes. R-021's reasoning, unchanged.
  const leaseTenant = await prisma.leaseTenant.findFirst({
    where: { tenantId: thread.tenantId, lease: { propertyId: thread.propertyId } },
    orderBy: { lease: { startsOn: 'desc' } },
    select: { lease: { select: { id: true, unitId: true } } },
  })
  if (!leaseTenant) return { outcome: 'threaded', threadId: thread.id }

  const habitabilityFlag = detectHabitabilityLanguage(args.body)
  const priority = suggestTicketPriority({ category: 'UNCATEGORIZED', habitabilityFlag })

  const ticket = await prisma.$transaction(async (tx) => {
    const created = await tx.ticket.create({
      data: {
        propertyId: thread.propertyId,
        unitId: leaseTenant.lease.unitId,
        leaseId: leaseTenant.lease.id,
        tenantId: thread.tenantId,
        source: 'EMAIL',
        // No category, for R-021's reason: R-019's structured intake earns
        // one by ASKING, and an email has answered nothing.
        category: 'UNCATEGORIZED',
        description: formatEmailTicketDescription(args.body),
        priority,
        habitabilityFlag,
      },
    })
    // R-097d's attachments were stored against the MESSAGE, which is where
    // they belong; this also hangs them off the ticket, which is what makes
    // the photograph appear on the job somebody is dispatched to. Without
    // it a tenant photographs a leak and the person sent to fix it never
    // sees the picture.
    await tx.document.updateMany({
      where: { messageId: routed.messageId, ticketId: null },
      data: { ticketId: created.id },
    })
    await auditAsSystem(
      'email-webhook',
      {
        action: 'ticket.submitted',
        entityType: 'Ticket',
        entityId: created.id,
        propertyId: thread.propertyId,
        after: { source: 'EMAIL', habitabilityFlag: created.habitabilityFlag },
      },
      tx,
    )
    await emitEvent(tx, {
      type: 'ticket.created',
      aggregateType: 'Ticket',
      aggregateId: created.id,
      propertyId: thread.propertyId,
      payload: { source: 'EMAIL' },
    })
    return created
  })

  return { outcome: 'ticket_opened', threadId: thread.id, ticketId: ticket.id }
}
