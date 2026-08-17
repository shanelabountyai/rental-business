import 'server-only'

import { noticeDocumentBlocks } from '@rental/core/notices'
import type { NoticeDocumentFacts } from '@rental/core/notices'
import { renderBlocksPdf } from '@/lib/pdf/render.ts'

// Rendering a notice to PDF (R-051, COMM-02).
//
// The drawing itself - wrapping, pagination, fonts, why pdf-lib at all - moved
// to `lib/pdf/render.ts` at R-052, when the communications transcript and the
// ledger statement needed the same machinery. What is left here is the one
// thing that is specific to a notice: its title.

/**
 * Renders a notice to PDF bytes.
 *
 * Returns a `Uint8Array` rather than writing anywhere: storing it is the
 * caller's job (`lib/notices/actions.ts`), which is what lets the same
 * renderer serve a preview that is never persisted.
 */
export async function renderNoticePdf(facts: NoticeDocumentFacts): Promise<Uint8Array> {
  return renderBlocksPdf(noticeDocumentBlocks(facts), {
    title: `${facts.noticeType} — ${facts.addressOfRecord}`,
  })
}
