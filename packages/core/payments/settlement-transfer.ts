import { type Column, type DocumentBlock, padColumns } from '../documents/blocks.ts'
import { type Cents, formatCents } from '../money/money.ts'
import { type BusinessDate, friendlyBusinessDate } from '../scheduling/local-time.ts'

// Recording the sweep between entities, and the report it was computed from
// (review finding 12's second half, R-198). Pure: what a recorded transfer must
// satisfy, and what the archived report says. The fetch and the write are
// apps/web/lib/reports/settlement-actions.ts.
//
// R-180 said what each LLC is owed out of the shared account. Nothing recorded
// that the money moved, and the report was regenerated on demand, so "on
// 4 October you moved $6,412 to Maple Holdings LLC, and here is the report it
// was computed from" could not be produced at all.
//
// TWO AMOUNTS, NOT ONE. `grossCents` is the report's figure for the window,
// recomputed by the caller at the moment of recording and never read off the
// form; the transfer is what left the account. They differ in the ordinary
// case - the report is before Stripe's fees and nothing here records a fee
// (R-180) - so keeping only one would either misstate the movement or lose the
// figure it was computed from.

export interface SettlementTransferInput {
  from: BusinessDate
  to: BusinessDate
  grossCents: Cents
  amountDollars: string
  transferredOn: string
  reference: string
}

export interface SettlementTransferViolation {
  /// `window` refuses the whole range rather than one field.
  field: 'window' | 'amountDollars' | 'transferredOn' | 'reference'
  message: string
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const DOLLARS = /^\d+(\.\d{1,2})?$/

export function validateSettlementTransfer(
  input: SettlementTransferInput,
  today: BusinessDate,
): { violations: SettlementTransferViolation[]; transferredCents: Cents | null } {
  const violations: SettlementTransferViolation[] = []

  // THE RANGE MUST HAVE ENDED. A payment settling later today would land in a
  // window whose transfer is already recorded, and the overlap refusal would
  // then keep it out of every later window too: money that belongs to no sweep
  // and says so nowhere. Waiting a day is the cheap side of that.
  if (input.to >= today) {
    violations.push({
      field: 'window',
      message:
        'This range has not ended yet, so money can still settle into it. Record the transfer once its last day has passed.',
    })
  }
  if (input.grossCents <= 0) {
    violations.push({
      field: 'window',
      message: 'Nothing is owed to this entity for this range, so there is no transfer to record.',
    })
  }

  const dollars = input.amountDollars.replace(/,/g, '').trim()
  const cents = DOLLARS.test(dollars) ? Math.round(Number(dollars) * 100) : null
  if (cents === null || cents <= 0) {
    violations.push({ field: 'amountDollars', message: 'Enter the amount moved, like 6412.37.' })
  } else if (input.grossCents > 0 && cents > input.grossCents) {
    violations.push({
      field: 'amountDollars',
      message: `More than the ${formatCents(input.grossCents)} this entity is owed for the range.`,
    })
  }

  if (!DAY.test(input.transferredOn)) {
    violations.push({ field: 'transferredOn', message: 'Enter the day the money was moved.' })
  } else if (input.transferredOn > today) {
    // String comparison is the right one for YYYY-MM-DD - no zone may touch a
    // calendar day (D-3).
    violations.push({ field: 'transferredOn', message: 'A transfer cannot be dated in the future.' })
  } else if (input.transferredOn < input.to) {
    violations.push({
      field: 'transferredOn',
      message: `The range runs to ${friendlyBusinessDate(input.to)}, so its money had not all settled before then.`,
    })
  }

  if (!input.reference.trim()) {
    violations.push({
      field: 'reference',
      message: "Enter the bank's confirmation or trace number.",
    })
  }

  return { violations, transferredCents: violations.length === 0 ? cents : null }
}

/// Widths sized the way DEPOSIT_SLIP_COLUMNS states its own: with single-space
/// gaps both tables come to 85 characters, inside the renderer's
/// MONO_LINE_CHARS (86 at 9pt Courier).
export const SETTLEMENT_PROPERTY_COLUMNS: readonly Column[] = [
  { width: 40 },
  { width: 14, align: 'right' },
  { width: 14, align: 'right' },
  { width: 14, align: 'right' },
]
export const SETTLEMENT_PAYMENT_COLUMNS: readonly Column[] = [
  { width: 12 },
  { width: 24 },
  { width: 20 },
  { width: 13, align: 'right' },
  { width: 12 },
]
const GAP = 1

function tableWidth(columns: readonly Column[]): number {
  return columns.reduce((sum, column) => sum + column.width, 0) + GAP * (columns.length - 1)
}

export interface SettlementReportFacts {
  entityName: string
  from: BusinessDate
  to: BusinessDate
  settledCents: Cents
  reversedCents: Cents
  grossCents: Cents
  transferredCents: Cents
  transferredOn: BusinessDate
  reference: string
  properties: readonly {
    name: string
    settledCents: Cents
    reversedCents: Cents
    netCents: Cents
  }[]
  payments: readonly {
    settledOn: BusinessDate
    property: string
    payer: string
    amountCents: Cents
    reversedOn: BusinessDate | null
  }[]
  recordedBy: string
  /// A timestamp, formatted by the caller - it needs a zone and a calendar day
  /// does not.
  generatedAt: string
}

export const SETTLEMENT_REPORT_DISCLAIMER =
  'Generated from the payment records of this system at the moment the transfer was recorded, and kept exactly as produced. It is not a bank or Stripe document.'

/// Dates arrive as `BusinessDate` and are formatted HERE (D-153), so no caller
/// can print `2026-03-31` into a document somebody files.
export function settlementReportBlocks(facts: SettlementReportFacts): DocumentBlock[] {
  const day = friendlyBusinessDate
  const blocks: DocumentBlock[] = [
    { kind: 'heading', text: 'SETTLEMENT REPORT' },
    { kind: 'meta', text: `Legal entity: ${facts.entityName}` },
    {
      kind: 'meta',
      text: `Settled into the shared account: ${day(facts.from)} to ${day(facts.to)}`,
    },
    {
      kind: 'meta',
      text: `Owed to the entity: ${formatCents(facts.grossCents)} (${formatCents(facts.settledCents)} settled, less ${formatCents(facts.reversedCents)} returned)`,
    },
    {
      kind: 'meta',
      text: `Transferred: ${formatCents(facts.transferredCents)} on ${day(facts.transferredOn)}, reference ${facts.reference}`,
    },
  ]
  if (facts.transferredCents < facts.grossCents) {
    blocks.push({
      kind: 'meta',
      text: `Left in the shared account: ${formatCents(facts.grossCents - facts.transferredCents)}`,
    })
  }
  blocks.push(
    { kind: 'meta', text: `Recorded by: ${facts.recordedBy}` },
    { kind: 'meta', text: `Generated: ${facts.generatedAt}` },
    {
      kind: 'paragraph',
      text: "Amounts are gross, before Stripe's processing fees, which this system does not record - a payout is smaller by whatever Stripe charged. Payments are dated by when they settled into the Stripe balance, not by payout, and only online payments are included: a check or cash never passed through the shared account.",
    },
    { kind: 'subheading', text: 'By property' },
    {
      kind: 'mono',
      text: [
        padColumns(['Property', 'Settled', 'Returned', 'Net'], SETTLEMENT_PROPERTY_COLUMNS, GAP),
        '-'.repeat(tableWidth(SETTLEMENT_PROPERTY_COLUMNS)),
      ].join('\n'),
    },
  )
  for (const property of facts.properties) {
    blocks.push({
      kind: 'mono',
      text: padColumns(
        [
          property.name,
          formatCents(property.settledCents),
          formatCents(property.reversedCents),
          formatCents(property.netCents),
        ],
        SETTLEMENT_PROPERTY_COLUMNS,
        GAP,
      ),
    })
  }
  blocks.push(
    {
      kind: 'mono',
      text: [
        '-'.repeat(tableWidth(SETTLEMENT_PROPERTY_COLUMNS)),
        padColumns(
          [
            'Total',
            formatCents(facts.settledCents),
            formatCents(facts.reversedCents),
            formatCents(facts.grossCents),
          ],
          SETTLEMENT_PROPERTY_COLUMNS,
          GAP,
        ),
      ].join('\n'),
    },
    { kind: 'subheading', text: 'Every payment behind the total' },
    {
      kind: 'mono',
      text: [
        padColumns(
          ['Settled', 'Property', 'Payer', 'Amount', 'Returned'],
          SETTLEMENT_PAYMENT_COLUMNS,
          GAP,
        ),
        '-'.repeat(tableWidth(SETTLEMENT_PAYMENT_COLUMNS)),
      ].join('\n'),
    },
  )
  for (const payment of facts.payments) {
    blocks.push({
      kind: 'mono',
      text: padColumns(
        [
          day(payment.settledOn),
          payment.property,
          payment.payer,
          formatCents(payment.amountCents),
          payment.reversedOn ? day(payment.reversedOn) : '-',
        ],
        SETTLEMENT_PAYMENT_COLUMNS,
        GAP,
      ),
    })
  }
  blocks.push({ kind: 'footer', text: SETTLEMENT_REPORT_DISCLAIMER })
  return blocks
}
