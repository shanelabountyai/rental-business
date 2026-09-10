import 'server-only'

import { createHash } from 'node:crypto'
import { type Prisma, prisma } from '@rental/db'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Keeping what an inbound email carried (COMM-08, R-097d).
//
// ==========================================================================
// THIS IS AN UNAUTHENTICATED PERSON PUTTING A FILE IN OUR STORAGE, and every
// rule below follows from that sentence. The webhook's shared secret proves
// the PROVIDER is real; it proves nothing about the sender, whose From:
// header is forgeable.
//
//   * A CLOSED TYPE LIST, not a block list. Images and PDFs are what tenants
//     and vendors actually send - a photograph of a leak, an invoice - and
//     everything else is dropped. A block list is a list somebody has to
//     keep ahead of, and this one does not have to be.
//   * A SIZE CAP AND A COUNT CAP. Without both, one message is an unbounded
//     write to somebody else's storage bill.
//   * THE DECLARED TYPE IS NOT TRUSTED FOR ANYTHING BUT THE DECISION. It is
//     recorded as `contentType` because that is what the sender claimed, and
//     the file route serves what is stored - nothing here executes, renders
//     or parses the bytes.
//   * THE FILENAME IS SANITISED FOR DISPLAY. `generateStorageKey` already
//     scrubs it for the key, but `Document.fileName` is rendered to staff,
//     and `invoice.pdf.exe` from a stranger should not read as an invoice.
//
// AND NOTHING IS STORED FOR AN UNROUTED MESSAGE. A `Document` must have a
// property; an unrouted message has none, and inventing one is precisely the
// guess `decideRoute` refuses. The COUNT is recorded instead, so whoever
// triages knows to ask for the photograph again - see
// `UnroutedMessage.attachmentsDropped`. Silently dropping is the defect this
// module exists to fix, and fixing only the easy half would leave it.
// ==========================================================================

export interface InboundAttachment {
  fileName: string
  contentType: string
  content: Buffer
}

/// 15MB each, matching R-019's tenant photo upload - the same phone takes
/// the same picture whichever way it is sent.
///
/// EXPORTED because `twilio-media.ts` has to refuse an oversized MMS BEFORE
/// it reads the body, which is a decision that has to agree with the one
/// below or one of them stops meaning anything (R-189).
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
/// Ten per message. A real reply carries one or two photographs; a hundred
/// is either a mistake or an attack, and both want the same answer. Exported
/// for the same reason: it is also the ceiling on how many outbound media
/// fetches one signed webhook may cause.
export const MAX_ATTACHMENT_COUNT = 10

const ALLOWED = /^(image\/(jpeg|png|gif|webp|heic|heif)|application\/pdf)$/i

export function acceptableAttachment(attachment: {
  contentType: string
  size: number
}): boolean {
  return (
    ALLOWED.test(attachment.contentType.split(';')[0]!.trim()) &&
    attachment.size > 0 &&
    attachment.size <= MAX_ATTACHMENT_BYTES
  )
}

/// What staff see. `generateStorageKey` already scrubs the name for the
/// storage key; this is the separate job of not letting a stranger choose
/// how a file is described on a screen.
export function displayFileName(raw: string): string {
  const trimmed = raw.trim().replace(/[\r\n\t]/g, ' ')
  const base = trimmed.split(/[\\/]/).pop() ?? 'attachment'
  const safe = base.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120)
  return safe.length > 0 ? safe : 'attachment'
}

/**
 * Stores the attachments that arrived on a routed message.
 *
 * Returns how many were KEPT and how many were refused, because the caller
 * has to be able to say so - a message whose photograph was too large is a
 * message somebody needs to reply to.
 */
export async function storeInboundAttachments(input: {
  attachments: readonly InboundAttachment[]
  messageId: string
  propertyId: string
  tenantId: string | null
  vendorId: string | null
}): Promise<{ kept: number; refused: number }> {
  const considered = input.attachments.slice(0, MAX_ATTACHMENT_COUNT)
  const overflow = input.attachments.length - considered.length
  let kept = 0
  let refused = overflow

  for (const attachment of considered) {
    if (!acceptableAttachment({ contentType: attachment.contentType, size: attachment.content.length })) {
      refused += 1
      continue
    }
    const fileName = displayFileName(attachment.fileName)
    const sha256 = createHash('sha256').update(attachment.content).digest('hex')
    const storageKey = generateStorageKey(input.propertyId, fileName)
    try {
      // Object before row, the order every archiver in this product uses:
      // an orphaned object is inert, an orphaned row is a broken link on a
      // screen.
      await storage.put(storageKey, attachment.content, attachment.contentType)
      await prisma.document.create({
        data: {
          propertyId: input.propertyId,
          tenantId: input.tenantId,
          vendorId: input.vendorId,
          messageId: input.messageId,
          // MAINTENANCE_PHOTO for an image, matching R-019's own type for
          // the same thing arriving through the portal - a photograph of a
          // leak is the same evidence whichever way it was sent. A PDF is
          // OTHER: it is as often an invoice as anything else, and guessing
          // would put a wrong retention rule on it (DOC-05).
          type: attachment.contentType.toLowerCase().startsWith('image/')
            ? 'MAINTENANCE_PHOTO'
            : 'OTHER',
          fileName,
          contentType: attachment.contentType,
          sizeBytes: attachment.content.length,
          storageKey,
          sha256,
        },
      })
      kept += 1
    } catch (error) {
      // One bad attachment must not cost the message. It is already filed by
      // the time this runs, which is the important half.
      console.error(`[inbound-email] could not store an attachment on ${input.messageId}`, error)
      refused += 1
    }
  }

  return { kept, refused }
}

/**
 * Hangs a message's attachments off the ticket they are about (R-189).
 *
 * ==========================================================================
 * THIS IS WHAT MAKES THE PHOTOGRAPH REACH THE PERSON HOLDING THE WRENCH, and
 * it is not cosmetic: `app/vendor/[token]/documents/[documentId]/route.ts`
 * grants a vendor a document on `document.ticketId === workOrder.ticketId`.
 * A `Document` that stays on the message alone is one the vendor's own link
 * correctly refuses, so an unparented photo is invisible to exactly the
 * person it was taken for.
 *
 * CALLED ON BOTH INTAKE OUTCOMES, not only on the one that opens a ticket
 * (D-204). R-097d's email path parented on creation and nothing parented a
 * reply, which for SMS is the majority case rather than the edge: a tenant
 * with anything open gets `thread_only`, so "texts the description, then
 * texts the photo" - two messages, the ordinary way a phone sends them - put
 * the words on the ticket and left the picture off it.
 *
 * `ticketId: null` in the WHERE, so a document already parented is never
 * moved. Attachments are stored by `receiveInboundMessage` before either
 * caller reaches a ticket, which is why this can run inside the same
 * transaction that creates one.
 * ==========================================================================
 */
export async function attachMessageDocumentsToTicket(
  db: Prisma.TransactionClient | typeof prisma,
  messageId: string,
  ticketId: string,
): Promise<void> {
  await db.document.updateMany({
    where: { messageId, ticketId: null },
    data: { ticketId },
  })
}
