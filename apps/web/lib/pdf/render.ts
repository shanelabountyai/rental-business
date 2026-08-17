import 'server-only'

import type { DocumentBlock, DocumentBlockKind } from '@rental/core/documents'
import { PDFDocument, StandardFonts, type PDFFont, rgb } from 'pdf-lib'

// Drawing a block document to PDF (R-051, generalized at R-052).
//
// WHY A REAL PDF AND NOT A PRINT STYLESHEET. R-051 wrote this for notices and
// the reasoning carries to everything here: the artifact posted on a door,
// handed to an adjuster or filed with a court has to be archived exactly as
// produced. A print-to-PDF route stores nothing, so the only record of what
// somebody actually received would be a template that has since been edited.
// A case defended on "we sent this" needs the this.
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

const SIZES: Record<DocumentBlockKind, number> = {
  heading: 16,
  subheading: 12,
  meta: 10,
  paragraph: 11,
  // 9pt Courier is 5.4pt per character, so 84 characters fit the 468pt text
  // column with a little slack. `MONO_COLUMNS` in core is sized against this
  // number, and `render.test.ts` pins the two together - a mono row wider
  // than the page would be silently clipped at the right margin, which is
  // the one failure this renderer must not have on a money document.
  mono: 9,
  footer: 8,
}

/// Leading, as a multiple of font size. Generous on body text because these
/// get read under stress and sometimes photocopied.
const LINE_HEIGHT = 1.45

/// Gap after each block, in points.
const SPACE_AFTER: Record<DocumentBlockKind, number> = {
  heading: 18,
  subheading: 8,
  meta: 4,
  paragraph: 12,
  // Nearly nothing: consecutive mono blocks are the rows of one table, and a
  // gap between them would read as a break in the table.
  mono: 1,
  footer: 6,
}

/// How many characters of Courier at `SIZES.mono` fit between the margins.
/// Exported so core's column widths can be asserted against it rather than
/// against a number somebody remembered.
export const MONO_LINE_CHARS = Math.floor(
  (PAGE_WIDTH - MARGIN * 2) / (SIZES.mono * 0.6),
)

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

export interface RenderOptions {
  /// The PDF's `/Title`. Also what a screen reader announces and what most
  /// viewers put in the window bar, so it is a real accessibility field
  /// rather than metadata nobody sees (§6.4).
  title: string
}

/**
 * Renders typed blocks to PDF bytes.
 *
 * Returns a `Uint8Array` rather than writing anywhere: storing it is the
 * caller's job, which is what lets the same renderer serve a preview that is
 * never persisted.
 */
export async function renderBlocksPdf(
  blocks: readonly DocumentBlock[],
  options: RenderOptions,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  // Helvetica, Helvetica-Bold and Courier are three of the fourteen standard
  // PDF fonts every reader has built in, so nothing is embedded and the file
  // stays a few kilobytes.
  const body = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const mono = await pdf.embedFont(StandardFonts.Courier)

  pdf.setTitle(options.title)
  pdf.setProducer('Rental Operations')
  // No CreationDate is set deliberately: pdf-lib defaults to now, and a
  // deterministic document is worth more here than a redundant timestamp -
  // the row that records when this was made already exists, and two clocks
  // that can disagree about one artifact is one clock too many.

  const maxWidth = PAGE_WIDTH - MARGIN * 2
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN

  const newPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    y = PAGE_HEIGHT - MARGIN
  }

  for (const block of blocks) {
    const size = SIZES[block.kind]
    const font =
      block.kind === 'heading' || block.kind === 'subheading'
        ? bold
        : block.kind === 'mono'
          ? mono
          : body
    const leading = size * LINE_HEIGHT
    const color = block.kind === 'footer' ? rgb(0.35, 0.35, 0.35) : rgb(0, 0, 0)

    // A mono block is PRE-FORMATTED - its spacing is the layout. Word-wrapping
    // it would re-flow a table row into two ragged ones and destroy the
    // column alignment it exists to provide, so its lines are drawn as given.
    const lines =
      block.kind === 'mono'
        ? block.text.split('\n')
        : wrap(block.text, font, size, maxWidth)

    for (const line of lines) {
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

/**
 * Appends whole PDFs to the end of a rendered document.
 *
 * This is how PAY-09's "Stripe invoice PDFs attached as the underlying
 * record" is satisfied (D-50): the statement we generate is followed by the
 * provider's own invoices, page for page, in one file somebody can hand over
 * without a covering email explaining which attachment is which.
 *
 * A source PDF that cannot be parsed is SKIPPED AND REPORTED, never silently
 * dropped - the caller puts the failure on the statement itself, because a
 * missing attachment with no note reads as "there was no invoice", which is a
 * different and false claim.
 */
export async function appendPdfs(
  base: Uint8Array,
  attachments: readonly { label: string; bytes: Uint8Array }[],
): Promise<{ bytes: Uint8Array; failed: string[] }> {
  if (attachments.length === 0) return { bytes: base, failed: [] }

  const pdf = await PDFDocument.load(base)
  const failed: string[] = []

  for (const attachment of attachments) {
    try {
      const source = await PDFDocument.load(attachment.bytes)
      const pages = await pdf.copyPages(source, source.getPageIndices())
      for (const page of pages) pdf.addPage(page)
    } catch {
      // An encrypted, truncated or non-PDF response. Named, not thrown: one
      // unreadable invoice must not cost the owner the entire statement.
      failed.push(attachment.label)
    }
  }

  return { bytes: await pdf.save(), failed }
}
