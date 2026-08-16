import 'server-only'

import { noticeDocumentBlocks } from '@rental/core/notices'
import type { NoticeDocumentBlock, NoticeDocumentFacts } from '@rental/core/notices'
import { PDFDocument, StandardFonts, type PDFFont, rgb } from 'pdf-lib'

// Rendering a notice to PDF (R-051, COMM-02). The first PDF path in this
// repo.
//
// WHY A REAL PDF AND NOT A PRINT STYLESHEET. The artifact that gets posted on
// a door or folded into a certified-mail envelope has to be archived exactly
// as served - `Notice.documentId` has said "the generated PDF" since R-002.
// A print-to-PDF route stores nothing, so the only record of what the tenant
// actually received would be a template that has since been edited. An
// eviction defended on "we sent this" needs the this.
//
// WHY pdf-lib. Pure JavaScript, no native binary and no headless browser, so
// it runs in a Vercel function without a custom runtime. The cost is that it
// draws text at coordinates and does not wrap or paginate - both are handled
// below, and they are the only reason this file is longer than a page.

/// US Letter, in PostScript points. Legal-size paper is a per-jurisdiction
/// nicety nobody has asked for; when somebody does, it is a parameter here.
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 72

const SIZES: Record<NoticeDocumentBlock['kind'], number> = {
  heading: 16,
  meta: 10,
  paragraph: 11,
  footer: 8,
}

/// Leading, as a multiple of font size. Generous on body text because these
/// get read under stress and sometimes photocopied.
const LINE_HEIGHT = 1.45

/// Gap after each block, in points.
const SPACE_AFTER: Record<NoticeDocumentBlock['kind'], number> = {
  heading: 18,
  meta: 4,
  paragraph: 12,
  footer: 6,
}

/**
 * Greedy word wrap against the real measured width of the chosen font.
 *
 * A single word longer than the line (a URL, a 40-character tracking number)
 * is emitted on its own over-long line rather than dropped or silently
 * clipped: an overflowing character is visible and fixable, a missing one is
 * neither.
 */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate
      } else {
        if (line) lines.push(line)
        line = word
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

/**
 * Renders a notice to PDF bytes.
 *
 * Returns a `Uint8Array` rather than writing anywhere: storing it is the
 * caller's job (`lib/notices/actions.ts`), which is what lets the same
 * renderer serve a preview that is never persisted.
 */
export async function renderNoticePdf(facts: NoticeDocumentFacts): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  // Helvetica and Helvetica-Bold are the two of the fourteen standard PDF
  // fonts every reader has built in, so nothing is embedded and the file
  // stays a few kilobytes.
  const body = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  pdf.setTitle(`${facts.noticeType} — ${facts.addressOfRecord}`)
  pdf.setProducer('Rental Operations')
  // No CreationDate is set deliberately: pdf-lib defaults to now, and a
  // deterministic document is worth more here than a redundant timestamp -
  // `Notice.generatedAt` and the Document row already record when this was
  // made, and two clocks that can disagree about one artifact is one clock
  // too many.

  const maxWidth = PAGE_WIDTH - MARGIN * 2
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN

  const newPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    y = PAGE_HEIGHT - MARGIN
  }

  for (const block of noticeDocumentBlocks(facts)) {
    const size = SIZES[block.kind]
    const font = block.kind === 'heading' ? bold : body
    const leading = size * LINE_HEIGHT
    const color = block.kind === 'footer' ? rgb(0.35, 0.35, 0.35) : rgb(0, 0, 0)

    for (const line of wrap(block.text, font, size, maxWidth)) {
      // Break BEFORE drawing, never after: a line drawn below the bottom
      // margin is a line that silently does not exist on the printed page.
      if (y - leading < MARGIN) newPage()
      page.drawText(line, { x: MARGIN, y: y - leading, size, font, color })
      y -= leading
    }
    y -= SPACE_AFTER[block.kind]
  }

  return pdf.save()
}
