// The printable deposit slip (PAY-05, R-166). Pure - what the page SAYS.
// Drawing it is `apps/web/lib/pdf/render.ts`, same split as the ledger
// statement this mirrors.
//
// A batch id on each Payment is the evidence that a check was deposited at
// all; this document is what the bank line reconciles TO - one row per
// payment, in the amount the bank actually receives, so "does this deposit
// match the batch" is a question anyone can answer by eye.

import { type Column, type DocumentBlock, padColumns } from '../documents/blocks.ts'
import { type Cents, formatCents } from '../money/money.ts'

const CHANNEL_LABELS: Record<string, string> = {
  OFFLINE_CHECK: 'Check',
  MONEY_ORDER: 'Money order',
  OFFLINE_CASH: 'Cash',
}

export function depositChannelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel
}

/// Four columns, widths sized the same way STATEMENT_COLUMNS states its
/// own: they sum, with single-space gaps, to comfortably inside the
/// renderer's MONO_LINE_CHARS at its default mono size.
export const DEPOSIT_SLIP_COLUMNS: readonly Column[] = [
  { width: 34 },
  { width: 14 },
  { width: 12 },
  { width: 14, align: 'right' },
]
export const DEPOSIT_SLIP_GAP = 1
export const DEPOSIT_SLIP_WIDTH =
  DEPOSIT_SLIP_COLUMNS.reduce((sum, column) => sum + column.width, 0) +
  DEPOSIT_SLIP_GAP * (DEPOSIT_SLIP_COLUMNS.length - 1)

export interface DepositSlipLine {
  /// Who the money is from and what it was for - "Jordan Ruiz — 42 Magnolia
  /// Dr" rather than a bare tenant name, because two tenants at two
  /// properties can share a first name and the bank line has to disambiguate
  /// the same way a human reading this slip would.
  description: string
  channel: string
  checkNumber: string | null
  amountCents: Cents
}

export interface DepositSlipFacts {
  entityName: string
  receivedByName: string
  /// Property-local, pre-formatted by the caller (D-3) - this module never
  /// reads a date out of an instant.
  receivedOn: string
  generatedAt: string
  lines: readonly DepositSlipLine[]
  totalCents: Cents
}

export const DEPOSIT_SLIP_DISCLAIMER =
  'Generated from the records of this system for the deposit made on the date above. It is not a bank document.'

export function depositSlipBlocks(facts: DepositSlipFacts): DocumentBlock[] {
  const blocks: DocumentBlock[] = [
    { kind: 'heading', text: 'DEPOSIT SLIP' },
    { kind: 'meta', text: `Account holder: ${facts.entityName}` },
    { kind: 'meta', text: `Received by: ${facts.receivedByName}` },
    { kind: 'meta', text: `Deposit date: ${facts.receivedOn}` },
    { kind: 'meta', text: `Generated: ${facts.generatedAt}` },
  ]

  blocks.push({
    kind: 'mono',
    text: [
      padColumns(
        ['From', 'Channel', 'Check #', 'Amount'],
        DEPOSIT_SLIP_COLUMNS,
        DEPOSIT_SLIP_GAP,
      ),
      '-'.repeat(DEPOSIT_SLIP_WIDTH),
    ].join('\n'),
  })

  for (const line of facts.lines) {
    blocks.push({
      kind: 'mono',
      text: padColumns(
        [
          line.description,
          depositChannelLabel(line.channel),
          line.checkNumber ?? '—',
          formatCents(line.amountCents),
        ],
        DEPOSIT_SLIP_COLUMNS,
        DEPOSIT_SLIP_GAP,
      ),
    })
  }

  blocks.push({
    kind: 'mono',
    text: [
      '-'.repeat(DEPOSIT_SLIP_WIDTH),
      padColumns(
        ['', '', 'Total', formatCents(facts.totalCents)],
        DEPOSIT_SLIP_COLUMNS,
        DEPOSIT_SLIP_GAP,
      ),
    ].join('\n'),
  })

  blocks.push({ kind: 'footer', text: DEPOSIT_SLIP_DISCLAIMER })

  return blocks
}
