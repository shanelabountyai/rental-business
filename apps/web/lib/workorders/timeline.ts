import 'server-only'

import type { TimelineEntry } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import { resolveThread } from '@/lib/comms/threads.ts'

// Assembling the merged timeline (COMM-06, R-032). The formatting logic
// lives in packages/core/workorders/timeline.ts; this is the database half -
// pulling the right rows and resolving them to the plain, already-named
// shape that pure function renders.

const CHANNEL_LABELS: Record<string, string> = {
  SMS: 'Text',
  EMAIL: 'Email',
  PORTAL: 'Portal',
  CALL_LOG: 'Phone call',
}

/**
 * The vendor's own thread for this work order (COMM-06's "vendor thread").
 *
 * Gets-or-creates, same as every other thread in this product - the first
 * message either side sends is what actually creates it. PORTAL only, by
 * construction: nothing here ever offers SMS/EMAIL for this thread, because
 * an SMS reply from the vendor would land in their PROPERTY-scoped thread
 * instead (see threadKey's own comment on why there are two kinds) and
 * silently split one conversation into two nobody reads together.
 */
export async function vendorWorkOrderThread(workOrder: {
  id: string
  propertyId: string
  vendorId: string
}) {
  return resolveThread({
    scope: 'VENDOR',
    propertyId: workOrder.propertyId,
    vendorId: workOrder.vendorId,
    workOrderId: workOrder.id,
  })
}

/**
 * Every entry that belongs on this work order's timeline, resolved and
 * ready to render or export.
 *
 * Sourced from three places, matching COMM-06 exactly: the tenant's
 * messages tagged to this incident, the vendor's own work-order-scoped
 * thread, and staff notes. The tenant's ORIGINAL report is synthesized from
 * the Ticket itself rather than read as a Message - a portal or
 * phone-logged submission never transmitted anything, so there is no
 * Message row to find (see the core module's own comment).
 */
export async function workOrderTimeline(workOrderId: string): Promise<TimelineEntry[]> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    select: {
      ticket: {
        select: {
          id: true,
          source: true,
          description: true,
          createdAt: true,
          tenant: { select: { firstName: true, lastName: true } },
        },
      },
    },
  })

  const messages = await prisma.message.findMany({
    where: {
      OR: [
        workOrder.ticket ? { ticketId: workOrder.ticket.id } : undefined,
        { workOrderId },
        // Tagged AFTER the fact, via WorkOrderMessageLink rather than a
        // column on the message itself - see that model's own comment for
        // why an update was never an option.
        { workOrderLink: { workOrderId } },
      ].filter((clause): clause is NonNullable<typeof clause> => clause != null),
    },
    orderBy: { sentAt: 'asc' },
    include: {
      staffUser: { select: { name: true } },
      tenant: { select: { firstName: true, lastName: true } },
      vendor: { select: { name: true } },
    },
  })

  const notes = await prisma.workOrderNote.findMany({
    where: { workOrderId },
    orderBy: { createdAt: 'asc' },
    include: { staffUser: { select: { name: true } } },
  })

  const entries: TimelineEntry[] = []

  if (workOrder.ticket) {
    entries.push({
      kind: 'ticket_submitted',
      at: workOrder.ticket.createdAt,
      author: workOrder.ticket.tenant
        ? `${workOrder.ticket.tenant.firstName} ${workOrder.ticket.tenant.lastName}`
        : 'Tenant',
      body: workOrder.ticket.description,
      channel: workOrder.ticket.source === 'SMS' ? 'Text' : undefined,
    })
  }

  for (const message of messages) {
    const outbound = message.direction === 'OUTBOUND'
    entries.push({
      kind:
        message.channel === 'CALL_LOG'
          ? 'call_log'
          : outbound
            ? 'staff_message'
            : message.vendorId
              ? 'vendor_message'
              : 'tenant_message',
      at: message.sentAt,
      author: outbound
        ? `${message.staffUser?.name ?? 'Staff'} (staff)`
        : message.vendor
          ? message.vendor.name
          : message.tenant
            ? `${message.tenant.firstName} ${message.tenant.lastName}`
            : 'Unknown',
      body: message.body,
      channel: CHANNEL_LABELS[message.channel] ?? message.channel,
    })
  }

  for (const note of notes) {
    entries.push({
      kind: 'staff_note',
      at: note.createdAt,
      author: `${note.staffUser.name} (staff)`,
      body: note.body,
    })
  }

  return entries.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/**
 * Tenant messages that MIGHT be about this job but are not tagged to it yet
 * (COMM-06's "reconstructing an incident from three separate histories").
 *
 * Inbound texts after the one that opened the ticket are not automatically
 * attributable to any one job - R-021's threading is deliberately one
 * continuous conversation per tenant, not a sub-thread per ticket, because
 * tenants do not context-switch cleanly over SMS. This is the deliberate
 * human step that closes the gap: a staff member reads the recent
 * conversation and decides which lines belong here, the same judgement call
 * `fileUnroutedMessage` already asks staff to make for a stranger's text.
 *
 * Scoped to the last 20 untagged messages in the tenant's thread - the
 * period this job has been open is usually much shorter than the tenant's
 * whole history with the property, and a bound here is what stops the list
 * growing without limit for a long-tenured tenant.
 */
export async function unattachedTenantMessages(workOrderId: string) {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    select: { ticket: { select: { tenantId: true, propertyId: true } } },
  })
  if (!workOrder.ticket?.tenantId) return []

  return prisma.message.findMany({
    where: {
      tenantId: workOrder.ticket.tenantId,
      // The tenant's THREAD at this property, not merely their id - a
      // tenant who has moved within the portfolio holds a separate
      // continuous thread per property (threadKey's own comment), and
      // without this a message from their old address could be offered up
      // to attach to a job at their new one.
      thread: { propertyId: workOrder.ticket.propertyId },
      ticketId: null,
      workOrderId: null,
      // Already linked to SOME job (not necessarily this one) via the
      // after-the-fact table - excluded everywhere once attached anywhere,
      // since a message belongs to at most one job.
      workOrderLink: null,
    },
    orderBy: { sentAt: 'desc' },
    take: 20,
    select: { id: true, body: true, sentAt: true, direction: true },
  })
}
