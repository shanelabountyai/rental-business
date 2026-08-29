import type { DocumentBlock } from '../documents/blocks.ts'
import { friendlyBusinessDate } from '../scheduling/local-time.ts'
import { noticeTypeLabel } from './service-methods.ts'

// The CONTENT of a served notice, as structured blocks (R-051, COMM-02).
//
// Layout lives in the app (`apps/web/lib/notices/pdf.ts`, which owns the
// pdf-lib dependency); what the page SAYS lives here, where it can be tested
// without rendering anything. Same split the product already runs for
// `entryNoticeText` and `chargebackNoticeText` - those generate the body,
// and this wraps a body in the letter around it.
//
// THE PDF IS THE ARCHIVED ARTIFACT, not a re-render. It is generated once,
// stored as a Document, and pointed at by `Notice.documentId`. Re-rendering
// from a template months later would show today's wording over a notice
// served under yesterday's - which is precisely the thing an evidence trail
// must not do.

export interface NoticeDocumentFacts {
  noticeType: string
  /// The address the notice was served to, as written on the notice itself.
  addressOfRecord: string
  propertyName: string
  unitName?: string | null
  tenantNames: readonly string[]
  bodyText: string
  /// Property-local calendar day the notice was generated (D-3). A string,
  /// because a calendar day is not an instant.
  generatedOn: string
  /// The statute version behind any deadline in the body, when there is one.
  citation?: string | null
}

/// An alias since R-052, which generalized this shape so the communications
/// transcript and the ledger statement could share one renderer. A notice
/// only ever uses the `heading`/`meta`/`paragraph`/`footer` kinds.
export type NoticeDocumentBlock = DocumentBlock

/// D-4's standing requirement, on every legal artifact this product emits.
/// The existing body generators each end with their own copy of this
/// sentence and `e2e/entry-notice.spec.ts` pins it; the PDF carries it too,
/// because the PDF is what gets posted on a door and read by somebody who
/// never saw the screen it came from.
export const NOTICE_DISCLAIMER =
  'This notice is a draft prepared from configured jurisdiction rules. It is not legal advice and has not been reviewed by an attorney for this matter.'

/**
 * The blocks that make up a printable notice, in order.
 *
 * Deliberately not HTML and not PDF primitives: a list of typed blocks is
 * renderable to either, and keeps every judgement about WHAT APPEARS on a
 * legal notice in one testable place.
 */
export function noticeDocumentBlocks(
  facts: NoticeDocumentFacts,
): NoticeDocumentBlock[] {
  const blocks: NoticeDocumentBlock[] = [
    { kind: 'heading', text: noticeTypeLabel(facts.noticeType).toUpperCase() },
  ]

  const where = facts.unitName
    ? `${facts.propertyName} — ${facts.unitName}`
    : facts.propertyName

  blocks.push({ kind: 'meta', text: `Date: ${friendlyBusinessDate(facts.generatedOn)}` })
  blocks.push({ kind: 'meta', text: `Property: ${where}` })
  blocks.push({ kind: 'meta', text: `Address of record: ${facts.addressOfRecord}` })
  // NAMED, and every name on the tenancy. A notice addressed to one of two
  // tenants is a notice one of them can say they never received.
  blocks.push({
    kind: 'meta',
    text: `To: ${facts.tenantNames.length > 0 ? facts.tenantNames.join(', ') : 'Occupant'}`,
  })

  // The body arrives as prose from whichever generator produced it; blank
  // lines are paragraph breaks, and each becomes its own block so the
  // renderer never has to guess where to break a page.
  for (const paragraph of facts.bodyText.split(/\n\s*\n/)) {
    const text = paragraph.trim()
    if (text) blocks.push({ kind: 'paragraph', text })
  }

  if (facts.citation) {
    blocks.push({ kind: 'footer', text: `Statute: ${facts.citation}` })
  }
  blocks.push({ kind: 'footer', text: NOTICE_DISCLAIMER })

  return blocks
}
