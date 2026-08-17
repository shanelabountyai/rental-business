'use server'

import { createHash } from 'node:crypto'
import type { CommsEntry } from '@rental/core/comms'
import { mergeCommsEntries, transcriptBlocks } from '@rental/core/comms'
import { SERVICE_METHOD_LABELS } from '@rental/core/notices'
import { businessDate, friendlyTimestamp } from '@rental/core/scheduling'
import { type Prisma, prisma } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { renderBlocksPdf } from '@/lib/pdf/render.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// The database half of the communications transcript (COMM-05, R-052). What
// the page SAYS is `packages/core/comms/transcript.ts`; this pulls the rows.
//
// THE GATHERING IS THE HARD PART, not the rendering. A thread holds Messages
// and nothing else, so a transcript built from a thread alone silently omits
// every automated notification and every served notice - which for an
// ordinary tenancy is most of what we ever sent them. See record.ts's own
// header for why that omission is worse than a missing document.

export interface FormState {
  error?: string
  notice?: string
  documentId?: string
}

/// Everything the transcript needs about the thread's party.
const THREAD_INCLUDE = {
  property: {
    select: {
      id: true,
      name: true,
      legalEntityId: true,
      timezone: true,
      addressLine1: true,
      active: true,
    },
  },
  tenant: { select: { id: true, firstName: true, lastName: true } },
  vendor: { select: { id: true, name: true } },
  messages: {
    orderBy: { sentAt: 'asc' as const },
    include: {
      delivery: true,
      staffUser: { select: { name: true } },
      tenant: { select: { firstName: true, lastName: true } },
      vendor: { select: { name: true } },
    },
  },
} satisfies Prisma.ThreadInclude

type ThreadRow = Prisma.ThreadGetPayload<{ include: typeof THREAD_INCLUDE }>

function partyOf(thread: ThreadRow): { name: string; role: string } {
  if (thread.tenant) {
    return {
      name: `${thread.tenant.firstName} ${thread.tenant.lastName}`,
      role: 'Tenant',
    }
  }
  if (thread.vendor) return { name: thread.vendor.name, role: 'Vendor' }
  return { name: thread.property.name, role: 'Property' }
}

/// The staff author of an outbound message, or a truthful stand-in.
///
/// "Not recorded" rather than the property's name: an outbound message with
/// no staff author is one the SYSTEM sent, and attributing it to a person who
/// did not send it is the kind of small invention that discredits a whole
/// document when it is noticed.
function authorOf(message: ThreadRow['messages'][number]): string {
  if (message.staffUser) return `${message.staffUser.name} (staff)`
  if (message.tenant) return `${message.tenant.firstName} ${message.tenant.lastName}`
  if (message.vendor) return message.vendor.name
  return message.direction === 'INBOUND' ? 'Unknown sender' : 'Sent automatically'
}

function messageEntries(thread: ThreadRow, partyName: string): CommsEntry[] {
  return thread.messages.map((message) => {
    const author = authorOf(message)
    return {
      kind: 'MESSAGE' as const,
      id: message.id,
      occurredAt: message.sentAt,
      channel: message.channel,
      direction: message.direction,
      from: message.direction === 'INBOUND' ? author : `${author} — management`,
      to: message.direction === 'INBOUND' ? 'Management' : partyName,
      body: message.body,
      deliveries: message.delivery
        ? [
            {
              status: message.delivery.status,
              detail: message.delivery.failureCode,
              deliveredAt: message.delivery.deliveredAt,
              readAt: message.delivery.readAt,
              failedAt: message.delivery.failedAt,
              externalId: message.delivery.externalId ?? message.externalId,
            },
          ]
        : [],
    }
  })
}

/**
 * The notifications the engine addressed to this party at this property.
 *
 * SCOPED BY RECIPIENT, NOT BY THREAD, because a Notification has no thread -
 * it is addressed to a (recipientType, recipientId) pair and deliberately so
 * (see the model's own comment). Property-less notifications are included for
 * a tenant recipient: a portfolio-wide message still went to this person, and
 * omitting it because it carried no propertyId would drop real evidence on a
 * technicality of how the row is scoped.
 */
async function notificationEntries(
  thread: ThreadRow,
  partyName: string,
): Promise<CommsEntry[]> {
  const recipientId = thread.tenantId ?? thread.vendorId
  if (!recipientId) return []

  const rows = await prisma.notification.findMany({
    where: {
      recipientType: thread.tenantId ? 'TENANT' : 'VENDOR',
      recipientId,
      OR: [{ propertyId: thread.propertyId }, { propertyId: null }],
    },
    include: { delivery: true },
    orderBy: { createdAt: 'asc' },
  })

  return rows.map((row) => ({
    kind: 'NOTIFICATION' as const,
    id: row.id,
    occurredAt: row.createdAt,
    channel: row.channel,
    direction: 'OUTBOUND' as const,
    from: 'Management (automated)',
    to: `${partyName} at ${row.toAddress}`,
    subject: row.subject,
    body: row.body,
    deliveries: row.delivery
      ? [
          {
            status: row.delivery.status,
            // A suppression reason and a provider failure code both land in
            // `detail`; `deliveryNarrative` reads the status to know which it
            // is holding, which is why the two can share one field.
            detail: row.delivery.suppressedReason ?? row.delivery.failureCode,
            sentAt: row.delivery.sentAt,
            deliveredAt: row.delivery.deliveredAt,
            failedAt: row.delivery.failedAt,
            externalId: row.delivery.externalId,
          },
        ]
      : [],
  }))
}

/**
 * Notices served on this tenant at this property.
 *
 * One entry per NOTICE with every service event on it as a delivery (R-051's
 * whole point: a notice posted on a door AND mailed is one artifact and two
 * service events). Vendors are not served notices, so this is tenant-only.
 */
async function noticeEntries(thread: ThreadRow, partyName: string): Promise<CommsEntry[]> {
  if (!thread.tenantId) return []

  const rows = await prisma.notice.findMany({
    where: {
      propertyId: thread.propertyId,
      lease: { leaseTenants: { some: { tenantId: thread.tenantId } } },
    },
    include: { deliveries: { orderBy: { servedAt: 'asc' } } },
    orderBy: { generatedAt: 'asc' },
  })

  return rows.map((notice) => ({
    kind: 'NOTICE' as const,
    id: notice.id,
    occurredAt: notice.generatedAt,
    // The FIRST service method, or the fact that it has not been served. A
    // drafted-but-unserved notice belongs in the transcript precisely because
    // "was this ever actually served" is the question it answers.
    channel: notice.deliveries[0]
      ? (SERVICE_METHOD_LABELS[notice.deliveries[0].method] ?? notice.deliveries[0].method)
      : 'Not yet served',
    direction: 'OUTBOUND' as const,
    from: 'Management',
    to: `${partyName} at ${notice.addressOfRecord}`,
    subject: notice.type,
    body: notice.bodyText ?? '(This notice has no recorded body text.)',
    deliveries: notice.deliveries.map((delivery) => ({
      status: SERVICE_METHOD_LABELS[delivery.method] ?? delivery.method,
      detail: delivery.trackingNumber,
      sentAt: delivery.servedAt,
      readAt: delivery.readAt,
      externalId: delivery.trackingNumber,
    })),
  }))
}

/**
 * Produces and archives a communications transcript for a thread's party.
 *
 * NOT IDEMPOTENT, unlike `generateNoticePdf` - and the difference is the
 * point. A notice is one artifact that was served once, so re-rendering it
 * would be a falsification. A transcript is a snapshot of a history that
 * keeps growing, so each export is a distinct, separately archived document
 * of what the record looked like on the day it was taken. That is what makes
 * "the transcript we gave the attorney in March" a thing that still exists in
 * June.
 */
export async function exportThreadTranscript(
  threadId: string,
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: THREAD_INCLUDE,
  })
  if (!thread) return { error: 'That conversation no longer exists.' }

  const actor = await requirePermission(
    'message.read',
    propertyResource(thread.property),
  )

  const party = partyOf(thread)
  const zone = thread.property.timezone
  const format = (instant: Date) => friendlyTimestamp(instant, zone)

  const entries = mergeCommsEntries(
    messageEntries(thread, party.name),
    await notificationEntries(thread, party.name),
    await noticeEntries(thread, party.name),
  )

  // `Actor` carries permissions, not a name (see rbac/can.ts). A document
  // that says who produced it needs the person, so it is looked up here
  // rather than the actor type being widened for one caller.
  const staff = await prisma.staffUser.findUnique({
    where: { id: actor.id },
    select: { name: true },
  })

  const generatedAt = new Date()
  const bytes = await renderBlocksPdf(
    transcriptBlocks(
      {
        partyName: party.name,
        partyRole: party.role,
        propertyName: thread.property.name,
        addressLine1: thread.property.addressLine1,
        unitName: null,
        timezone: zone,
        generatedAt: format(generatedAt),
        generatedBy: staff?.name ?? 'Not recorded',
        entries,
      },
      format,
    ),
    { title: `Communications transcript — ${party.name}` },
  )

  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  // The PROPERTY's calendar day, not the server's (D-3) - same call the
  // notice PDF makes, so two documents produced in one session sort together.
  const fileName = `transcript-${party.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${businessDate(generatedAt, zone)}.pdf`
  const storageKey = generateStorageKey(thread.propertyId, fileName)
  // Stored before the row, same order and same reasoning as uploadDocument:
  // an orphaned object costs disk, an orphaned row costs a document nobody
  // can open.
  await storage.put(storageKey, buffer, 'application/pdf')

  const documentId = await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId: thread.propertyId,
        // Deliberately NOT linked to the tenant: a `tenantId` would publish
        // this into their own /portal/papers list, and a packet assembled for
        // a dispute with that tenant is not a document to hand them by
        // accident. Staff reach it through the property's documents.
        type: 'COMMS_TRANSCRIPT',
        fileName,
        contentType: 'application/pdf',
        sizeBytes: buffer.byteLength,
        storageKey,
        sha256,
        uploadedByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'comms.transcript_exported',
        entityType: 'Thread',
        entityId: thread.id,
        propertyId: thread.propertyId,
        after: {
          documentId: document.id,
          party: party.name,
          entryCount: entries.length,
          sha256,
        },
      },
      tx,
    )
    return document.id
  })

  return {
    notice: `Transcript produced: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}.`,
    documentId,
  }
}
