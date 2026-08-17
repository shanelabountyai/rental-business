// The court-ready ledger statement (PAY-09, R-052). Pure - what the page
// SAYS. Drawing it is `apps/web/lib/pdf/render.ts`.
//
// PAY-09, and the acceptance criterion behind it: "when I export the ledger,
// then the output is judge-readable: chronological, plain language, no
// cryptic codes."
//
// ==========================================================================
// "NO CRYPTIC CODES" IS A REQUIREMENT ABOUT THE READER, NOT ABOUT STYLE.
//
// The person this document has to work for has never seen this system, is
// reading it once, under time pressure, alongside the other side's version of
// the same events. Every token that needs a key to decode - `LATE_FEE`,
// `REVERSAL`, `ADJUSTMENT`, a bare negative number - is a place they stop, or
// worse, guess. So:
//
//   - every entry type is spelled out in a sentence a layperson reads
//   - a reversal SAYS it corrects an earlier line, and the corrected line
//     stays visible, because D-11 forbids editing history and a reader who
//     cannot see the correction cannot check it
//   - a credit balance prints as "CR" with a footnote, not as a minus sign
//     that reads as a typo
//   - the money columns line up, which is why this file lays out characters
//     rather than emitting prose
// ==========================================================================

import { type DocumentBlock, padColumns, wrapMono } from '../documents/blocks.ts'
import { type Cents, formatCents } from '../money/money.ts'
import { type StatementLine, reversedEntryIds } from './balance.ts'

/// The five columns of the statement table.
///
/// Widths sum, with single-space gaps, to 84 characters - the number of
/// Courier glyphs that fit between the margins at the renderer's mono size.
/// `MONO_LINE_CHARS` in the renderer is the authority and a test pins these
/// against it, because a row one character too wide is clipped at the right
/// margin, and the column that would lose its last digit is the balance.
export const STATEMENT_COLUMNS = [
  { width: 11 },
  { width: 33 },
  { width: 12, align: 'right' as const },
  { width: 12, align: 'right' as const },
  { width: 12, align: 'right' as const },
]

export const STATEMENT_GAP = 1

/// The total width the columns above occupy. Exported so the renderer's own
/// capacity can be asserted against it rather than against a literal.
export const STATEMENT_WIDTH =
  STATEMENT_COLUMNS.reduce((sum, column) => sum + column.width, 0) +
  STATEMENT_GAP * (STATEMENT_COLUMNS.length - 1)

/// Plain English for a `LedgerEntryType`. The description column already
/// carries the specifics ("Rent — March 2026"); this says what KIND of event
/// the line is, in words rather than in an enum token.
const TYPE_LABELS: Record<string, string> = {
  CHARGE: 'Amount charged',
  PAYMENT: 'Payment received',
  CREDIT: 'Credit applied',
  REVERSAL: 'Correction of an earlier entry',
  ADJUSTMENT: 'Adjustment',
}

export function entryTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

/**
 * Money as it appears in a balance column.
 *
 * A NEGATIVE BALANCE IS A CREDIT AND SAYS SO. `-$25.00` in a column of
 * positive figures reads as a mistake or a minus that got lost in a
 * photocopy; `$25.00 CR` reads as a fact, and the footer defines CR once.
 * Uses `formatCents` rather than its own arithmetic - D-10 keeps one
 * formatter, and a statement is the last place to start a second.
 */
export function balanceLabel(cents: Cents): string {
  return cents < 0 ? `${formatCents(-cents)} CR` : formatCents(cents)
}

export interface StatementFacts {
  propertyName: string
  addressLine1: string
  unitName?: string | null
  /// Every name on the tenancy. A statement naming one of two tenants is one
  /// the other can say was never about them.
  tenantNames: readonly string[]
  /// The period, pre-formatted by the caller in the property's zone. Null
  /// where that end of the window was left open.
  periodFrom?: string | null
  periodTo?: string | null
  timezone: string
  generatedAt: string
  generatedBy: string
  /// Renders an instant as the date column, in the property's zone (D-3).
  /// Injected rather than done here because core must never guess a timezone,
  /// and held on the facts rather than passed separately so that every date in
  /// the document goes through one function - a statement with two date
  /// formats on it looks assembled from two sources, which is the opposite of
  /// the impression it needs to make.
  formatDate: (instant: Date) => string
  openingBalanceCents: Cents
  closingBalanceCents: Cents
  lines: readonly StatementLine[]
  /// Stripe invoice ids appended to this document as whole PDFs, in the order
  /// they were appended (D-50).
  attachedInvoiceIds: readonly string[]
  /// Invoice ids that were cited on a line but could NOT be attached. Printed
  /// explicitly - see the attachment section's own comment.
  unattachedInvoiceIds: readonly string[]
}

/// Maps a ledger row to the Stripe invoice behind it, when there is one.
export type InvoiceRefOf = (line: StatementLine) => string | null

export const STATEMENT_DISCLAIMER =
  'This statement is produced from the records of this system. It is not legal advice and has not been reviewed by an attorney for this matter.'

/**
 * The blocks of a court-ready statement, in order.
 */
export function statementBlocks(
  facts: StatementFacts,
  invoiceRefOf: InvoiceRefOf = () => null,
): DocumentBlock[] {
  const where = facts.unitName
    ? `${facts.propertyName} — ${facts.unitName}`
    : facts.propertyName

  const period =
    facts.periodFrom && facts.periodTo
      ? `${facts.periodFrom} to ${facts.periodTo}`
      : facts.periodFrom
        ? `${facts.periodFrom} onwards`
        : facts.periodTo
          ? `up to ${facts.periodTo}`
          : 'the entire tenancy'

  const blocks: DocumentBlock[] = [
    { kind: 'heading', text: 'STATEMENT OF ACCOUNT' },
    { kind: 'meta', text: `Property: ${where}` },
    { kind: 'meta', text: `Address: ${facts.addressLine1}` },
    {
      kind: 'meta',
      text: `Tenant${facts.tenantNames.length === 1 ? '' : 's'}: ${
        facts.tenantNames.length > 0 ? facts.tenantNames.join(', ') : 'Not recorded'
      }`,
    },
    { kind: 'meta', text: `Period: ${period}` },
    { kind: 'meta', text: `Produced: ${facts.generatedAt}` },
    { kind: 'meta', text: `Produced by: ${facts.generatedBy}` },
    {
      kind: 'paragraph',
      text:
        'This statement lists every charge and payment recorded against this tenancy in the period shown, in the order it happened. ' +
        `Dates are local to the property (${facts.timezone}). ` +
        'The balance column is what was owed immediately after each entry.',
    },
  ]

  const reversed = reversedEntryIds(facts.lines)

  // Header row and rule, in the same mono block so they can never be
  // separated by a page break with the rule left orphaned above the columns.
  blocks.push({
    kind: 'mono',
    text: [
      padColumns(
        ['Date', 'Description', 'Charges', 'Payments', 'Balance'],
        STATEMENT_COLUMNS,
        STATEMENT_GAP,
      ),
      '-'.repeat(STATEMENT_WIDTH),
    ].join('\n'),
  })

  blocks.push({
    kind: 'mono',
    text: padColumns(
      ['', 'Balance brought forward', '', '', balanceLabel(facts.openingBalanceCents)],
      STATEMENT_COLUMNS,
      STATEMENT_GAP,
    ),
  })

  if (facts.lines.length === 0) {
    // Said outright rather than left as an empty table. "Nothing happened in
    // this period" is frequently the finding the statement was requested to
    // establish, and a blank space does not establish it.
    blocks.push({
      kind: 'paragraph',
      text: 'No charges or payments are recorded for this tenancy in this period.',
    })
  }

  for (const line of facts.lines) {
    // Signed convention, from the schema: positive increases what is owed.
    // The two money columns make the sign redundant on the page, which is
    // exactly what stops a reader having to decode one.
    const charge = line.amountCents > 0 ? formatCents(line.amountCents) : ''
    const payment = line.amountCents < 0 ? formatCents(-line.amountCents) : ''

    blocks.push({
      kind: 'mono',
      text: padColumns(
        [
          facts.formatDate(line.occurredAt),
          line.description,
          charge,
          payment,
          balanceLabel(line.runningBalanceCents),
        ],
        STATEMENT_COLUMNS,
        STATEMENT_GAP,
      ),
    })

    // The continuation line: what did not fit, and what backs the entry up.
    // Only emitted when it has something to say, so an ordinary rent line
    // stays one line and the table stays readable.
    const notes: string[] = [entryTypeLabel(line.type)]
    if (line.description.length > STATEMENT_COLUMNS[1]!.width) {
      // The description was truncated in the column above. Printing it in
      // full here is why `padColumns` is allowed to truncate at all.
      notes.push(line.description)
    }
    if (reversed.has(line.id)) {
      notes.push('this entry was later corrected — see the correction below')
    }
    if (line.reversesId) {
      notes.push('corrects an earlier entry in this statement')
    }
    const invoiceRef = invoiceRefOf(line)
    if (invoiceRef) notes.push(`Stripe invoice ${invoiceRef}`)

    if (notes.length > 1 || invoiceRef) {
      // WRAPPED, never truncated. This line exists to carry what did not fit
      // above it, so cutting it would defeat the only reason it is here -
      // which is exactly what the first draft did until its test caught it.
      // Indented under the description column so the table still reads as
      // rows rather than as prose interleaved with numbers.
      blocks.push({
        kind: 'mono',
        text: wrapMono(
          notes.join(' · '),
          STATEMENT_WIDTH,
          STATEMENT_COLUMNS[0]!.width + STATEMENT_GAP,
        ).join('\n'),
      })
    }
  }

  blocks.push({
    kind: 'mono',
    text: [
      '-'.repeat(STATEMENT_WIDTH),
      padColumns(
        ['', 'Balance owed at end of period', '', '', balanceLabel(facts.closingBalanceCents)],
        STATEMENT_COLUMNS,
        STATEMENT_GAP,
      ),
    ].join('\n'),
  })

  if (facts.closingBalanceCents < 0) {
    blocks.push({
      kind: 'paragraph',
      text: 'CR means the account is in credit: the balance shown is money held on the tenant\'s behalf, not money they owe.',
    })
  }

  blocks.push(...attachmentBlocks(facts))
  blocks.push({ kind: 'footer', text: STATEMENT_DISCLAIMER })

  return blocks
}

/**
 * The attachment section (D-50).
 *
 * AN INVOICE THAT COULD NOT BE ATTACHED IS NAMED, NOT OMITTED. Stripe is the
 * system of record for money (D-11), so the invoices appended after this page
 * are the underlying evidence and the statement above is the projection of
 * them. If one could not be fetched - the provider was down, the adapter is
 * the simulator, the invoice was deleted - a statement that simply had one
 * fewer attachment would read as "there was no invoice for that line", which
 * is a different and false claim. Saying which ones are missing costs three
 * lines and keeps the document honest about its own gaps.
 */
function attachmentBlocks(facts: StatementFacts): DocumentBlock[] {
  if (facts.attachedInvoiceIds.length === 0 && facts.unattachedInvoiceIds.length === 0) {
    return []
  }

  const blocks: DocumentBlock[] = [
    { kind: 'subheading', text: 'Underlying records' },
  ]

  if (facts.attachedInvoiceIds.length > 0) {
    blocks.push({
      kind: 'paragraph',
      text:
        'The invoices issued by the payment processor for the entries above are appended to this document in full, in this order: ' +
        `${facts.attachedInvoiceIds.join(', ')}.`,
    })
  }

  if (facts.unattachedInvoiceIds.length > 0) {
    blocks.push({
      kind: 'paragraph',
      text:
        'These invoices are cited above but could not be retrieved when this statement was produced, and are NOT appended: ' +
        `${facts.unattachedInvoiceIds.join(', ')}. ` +
        'They remain obtainable from the payment processor.',
    })
  }

  return blocks
}
