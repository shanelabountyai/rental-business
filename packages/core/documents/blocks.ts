// The printable-document block vocabulary (R-051, generalized at R-052).
//
// R-051 introduced this shape for notices: core decides WHAT A PAGE SAYS as a
// list of typed blocks, and the app draws them (`apps/web/lib/pdf/render.ts`
// owns the pdf-lib dependency). The split is what lets every judgement about
// the content of a legal artifact be unit-tested without rendering anything.
//
// R-052 needs two more printable artifacts - a communications transcript and
// a court-ready ledger statement - and both wanted exactly this. Rather than
// two more private block types and two more renderers, the type moved here
// and the renderer became one. `NoticeDocumentBlock` is now an alias of it,
// so nothing about notices changed.

export type DocumentBlockKind =
  /// The document's own title. One per document, first.
  | 'heading'
  /// A section within it - one entry in a transcript, "Charges and payments"
  /// in a statement.
  | 'subheading'
  /// A labelled fact line: dates, addresses, parties, delivery status.
  | 'meta'
  /// Body prose.
  | 'paragraph'
  /// PRE-FORMATTED, drawn in a monospaced font so columns line up.
  ///
  /// This exists because PAY-09 asks for a money statement "a judge has to
  /// read", and a money statement is a table. There is no table primitive
  /// here and adding one would mean column models, measurement and cell
  /// wrapping in the renderer. Padding the columns with spaces and drawing
  /// the line in Courier gets the same aligned result, and the alignment is
  /// then decided in core where it can be asserted character-by-character in
  /// a test - which a coordinate-drawn table could not be.
  ///
  /// The cost, named: the caller owns the column widths, and a value wider
  /// than its column pushes the row out of alignment rather than wrapping.
  /// `padColumns` below is the one place that happens, and it truncates
  /// deliberately rather than letting a long description silently shift
  /// every number on the line.
  | 'mono'
  /// Small print - citations, disclaimers, provenance.
  | 'footer'

export interface DocumentBlock {
  kind: DocumentBlockKind
  text: string
}

/// One column in a `mono` row.
export interface Column {
  /// Width in characters. The renderer's monospaced font makes this exact.
  width: number
  align?: 'left' | 'right'
}

/**
 * Lays out one pre-formatted row for a `mono` block.
 *
 * TRUNCATION IS DELIBERATE AND VISIBLE. A description longer than its column
 * is cut and marked with an ellipsis rather than allowed to run on, because
 * the alternative pushes every money column on that row out of alignment -
 * and a statement whose numbers do not line up is precisely the document
 * nobody can read. The full text is never only here: a truncated description
 * always has its untruncated form somewhere else in the same document (the
 * statement puts it on the line beneath), so nothing is actually lost.
 */
export function padColumns(
  values: readonly string[],
  columns: readonly Column[],
  gap = 2,
): string {
  return values
    .map((value, index) => {
      const column = columns[index]
      if (!column) return value
      const text =
        value.length > column.width
          ? `${value.slice(0, Math.max(0, column.width - 1))}…`
          : value
      return column.align === 'right'
        ? text.padStart(column.width)
        : text.padEnd(column.width)
    })
    .join(' '.repeat(gap))
    // Trailing padding on the last column is invisible in a PDF and only
    // makes a test's expected string harder to read.
    .trimEnd()
}

/**
 * Word-wraps text into indented monospaced lines.
 *
 * WHY THIS EXISTS RATHER THAN ANOTHER `padColumns` CALL. The continuation
 * line under a table row carries exactly the text that did NOT fit in its
 * column - the full description, the correction note, the invoice reference.
 * Running it back through a truncating layout would cut the one thing it was
 * added to show, which is how the first draft of this shipped and what its
 * test caught.
 *
 * Character counting is exact here in a way it never is for proportional
 * text: the renderer draws these in Courier, so one character is one cell.
 *
 * A single word longer than the width is emitted on its own over-long line
 * rather than broken or dropped - the same call the app's proportional
 * wrapper makes, for the same reason: an overflowing character is visible and
 * fixable, a missing one is neither.
 */
export function wrapMono(text: string, width: number, indent = 0): string[] {
  const pad = ' '.repeat(indent)
  const available = Math.max(1, width - indent)
  const lines: string[] = []
  let line = ''

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length <= available) {
      line = candidate
    } else {
      if (line) lines.push(pad + line)
      line = word
    }
  }
  if (line) lines.push(pad + line)
  return lines
}
