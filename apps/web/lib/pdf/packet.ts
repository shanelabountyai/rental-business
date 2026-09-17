import 'server-only'

import { prisma } from '@rental/db'
import { appendPdfs } from '@/lib/pdf/render.ts'
import { storage } from '@/lib/storage/index.ts'

// Assembling a packet of archived documents behind a rendered cover sheet
// (D-50), lifted out of R-083's attorney packet when R-218's deposit packet
// needed the identical thing. Two copies of "render, append, re-render the
// index if anything would not parse" is one copy that eventually ships an
// index claiming an attachment the file does not contain.

export interface PacketCandidate {
  documentId: string
  label: string
  kind: string
  occurredAt: Date | null
}

/**
 * Fetches each candidate's bytes, renders the cover, appends everything, and
 * re-renders once if any attachment would not parse.
 *
 * `render` is handed `isAttached(documentId)` and must build its exhibit
 * index from it. A storage miss is a named gap, never a failed export - one
 * unreadable photograph must not cost the owner the whole packet.
 * `leading` are packet-generated PDFs (a statement of account) that go first
 * and are keyed by their own `label`.
 */
export async function assemblePacket(args: {
  candidates: readonly PacketCandidate[]
  leading?: readonly { label: string; bytes: Uint8Array }[]
  render: (isAttached: (documentId: string) => boolean) => Promise<Uint8Array>
}): Promise<{ bytes: Buffer; attachedCount: number; notAttached: string[] }> {
  const leading = args.leading ?? []

  // Storage is keyed by `Document.storageKey`, not by document id - resolved
  // in one query rather than one per exhibit, since a packet routinely cites
  // dozens of photographs.
  const keyById = new Map(
    (
      await prisma.document.findMany({
        where: { id: { in: args.candidates.map((c) => c.documentId) } },
        select: { id: true, storageKey: true },
      })
    ).map((d) => [d.id, d.storageKey]),
  )
  const fetched = await Promise.all(
    args.candidates.map(async (candidate) => {
      const key = keyById.get(candidate.documentId)
      if (!key) return { candidate, bytes: null }
      try {
        return { candidate, bytes: await storage.get(key) }
      } catch {
        return { candidate, bytes: null }
      }
    }),
  )

  const available = fetched.filter((row): row is { candidate: PacketCandidate; bytes: Buffer } => row.bytes !== null)
  const unreadable = new Set(fetched.filter((row) => row.bytes === null).map((row) => row.candidate.documentId))
  const render = (failed: ReadonlySet<string>) =>
    args.render((documentId) => !unreadable.has(documentId) && !failed.has(documentId))

  const attachments = [
    ...leading,
    ...available.map((row) => ({
      label: row.candidate.documentId,
      bytes: new Uint8Array(row.bytes),
    })),
  ]

  const first = await appendPdfs(await render(new Set()), attachments)

  // AN EXHIBIT THAT ARRIVED BUT WOULD NOT PARSE IS AS ABSENT AS ONE THAT
  // NEVER ARRIVED - and the index has already been rendered claiming it was
  // attached. Photographs make this the common case rather than the rare
  // one: a JPEG is not a PDF and `appendPdfs` correctly refuses it, so the
  // second render is what keeps the index honest about every image in the
  // bundle. One extra pass; the alternative is a document that names
  // attachments it does not contain.
  let bytes = first.bytes
  const failed = new Set(first.failed)
  if (failed.size > 0) {
    const corrected = await appendPdfs(
      await render(failed),
      attachments.filter((attachment) => !failed.has(attachment.label)),
    )
    bytes = corrected.bytes
  }

  const notAttached = [...new Set([...unreadable, ...failed])]
  return {
    bytes: Buffer.from(bytes),
    attachedCount: attachments.length - failed.size,
    notAttached,
  }
}
