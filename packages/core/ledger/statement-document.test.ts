import { describe, expect, it } from 'vitest'
import {
  STATEMENT_COLUMNS,
  STATEMENT_GAP,
  STATEMENT_WIDTH,
  type StatementFacts,
  type StatementLine,
  balanceLabel,
  entryTypeLabel,
  statementBlocks,
  statementForPeriod,
} from './index.ts'

// PAY-09's statement, and the arithmetic underneath it. The tests that matter
// here are the ones for failures that would be INVISIBLE on the finished
// page: a balance that starts at zero, a column clipped at the margin, an
// attachment named but absent.

const AT = (day: number) => new Date(Date.UTC(2026, 2, day, 12))

function line(
  id: string,
  amountCents: number,
  day: number,
  description = 'Rent',
  extra: Partial<StatementLine> = {},
): StatementLine {
  return {
    id,
    type: amountCents > 0 ? 'CHARGE' : 'PAYMENT',
    amountCents,
    occurredAt: AT(day),
    description,
    runningBalanceCents: 0,
    ...extra,
  }
}

function facts(overrides: Partial<StatementFacts> = {}): StatementFacts {
  return {
    propertyName: 'Cedar Row',
    addressLine1: '12 Cedar Row',
    unitName: 'A',
    tenantNames: ['Dana Reyes'],
    periodFrom: '1 Mar 2026',
    periodTo: '31 Mar 2026',
    timezone: 'America/Chicago',
    generatedAt: '2 Apr 2026, 09:14 CDT',
    generatedBy: 'Alex Chen',
    formatDate: (instant) => instant.toISOString().slice(0, 10),
    openingBalanceCents: 0,
    closingBalanceCents: 0,
    lines: [],
    attachedInvoiceIds: [],
    unattachedInvoiceIds: [],
    ...overrides,
  }
}

const textOf = (blocks: { text: string }[]) => blocks.map((b) => b.text).join('\n')

/// The document's text with runs of whitespace collapsed.
///
/// Assertions about CONTENT must not depend on where a line happens to wrap -
/// the continuation lines are wrapped to the page width, so a phrase that fits
/// on one line today straddles two the moment a column changes. Tests that
/// pinned the wrap position would fail on every layout tweak while catching
/// nothing real; the layout itself is asserted separately, by width.
const flat = (blocks: { text: string }[]) => textOf(blocks).replace(/\s+/g, ' ')

describe('statementForPeriod', () => {
  const rows = [
    { id: 'feb-rent', type: 'CHARGE', amountCents: 150_000, occurredAt: AT(-15), description: 'Rent — February' },
    { id: 'feb-part', type: 'PAYMENT', amountCents: -100_000, occurredAt: AT(-10), description: 'Payment' },
    { id: 'mar-rent', type: 'CHARGE', amountCents: 150_000, occurredAt: AT(1), description: 'Rent — March' },
    { id: 'mar-pay', type: 'PAYMENT', amountCents: -150_000, occurredAt: AT(3), description: 'Payment' },
  ]

  it('carries the earlier balance INTO the period rather than starting at zero', () => {
    // The defect this function exists to prevent. February left $500 owed; a
    // March statement that opened at zero would close $500 light with every
    // line on it arithmetically correct - internally consistent and
    // materially false, which is the worst thing a court document can be.
    const result = statementForPeriod(rows, AT(1), AT(31))

    expect(result.openingBalanceCents).toBe(50_000)
    expect(result.lines.map((l) => l.id)).toEqual(['mar-rent', 'mar-pay'])
    // Opening 500 + 1500 charged - 1500 paid = 500 still owed.
    expect(result.closingBalanceCents).toBe(50_000)
    // And every running balance is the REAL balance on that date, not one
    // relative to the window.
    expect(result.lines[0]!.runningBalanceCents).toBe(200_000)
  })

  it('closes at the period end even when later entries exist', () => {
    // A statement filed for March must not silently include April's rent
    // because the ledger has moved on since.
    const withApril = [
      ...rows,
      { id: 'apr-rent', type: 'CHARGE', amountCents: 150_000, occurredAt: AT(35), description: 'Rent — April' },
    ]
    expect(statementForPeriod(withApril, AT(1), AT(31)).closingBalanceCents).toBe(50_000)
  })

  it('treats a null bound as an open end', () => {
    const all = statementForPeriod(rows, null, null)
    expect(all.openingBalanceCents).toBe(0)
    expect(all.lines).toHaveLength(4)
    expect(all.closingBalanceCents).toBe(50_000)
  })

  it('reports the carried balance as the closing one when nothing happened', () => {
    // An empty period is a real answer, and "they owed $500 throughout" is
    // usually the point of asking.
    const quiet = statementForPeriod(rows, AT(10), AT(20))
    expect(quiet.lines).toHaveLength(0)
    expect(quiet.openingBalanceCents).toBe(50_000)
    expect(quiet.closingBalanceCents).toBe(50_000)
  })
})

describe('statement layout', () => {
  it('fits the page width the renderer actually has', () => {
    // A row one character too wide is clipped at the right margin, and the
    // column that loses its digits is the balance. 84 is the Courier capacity
    // computed in apps/web/lib/pdf/render.ts (MONO_LINE_CHARS); this pins the
    // column budget against it so widening a column has to fail here rather
    // than silently truncate a number on a court exhibit.
    expect(STATEMENT_WIDTH).toBe(84)
    expect(STATEMENT_WIDTH).toBe(
      STATEMENT_COLUMNS.reduce((sum, c) => sum + c.width, 0) +
        STATEMENT_GAP * (STATEMENT_COLUMNS.length - 1),
    )
  })

  it('never emits a table row wider than the budget', () => {
    const long = 'Rent, late fee and the utility reconciliation for the whole quarter'
    const blocks = statementBlocks(
      facts({
        lines: [{ ...line('a', 150_000, 1, long), runningBalanceCents: 150_000 }],
        closingBalanceCents: 150_000,
      }),
    )
    for (const block of blocks.filter((b) => b.kind === 'mono')) {
      for (const row of block.text.split('\n')) {
        expect(row.length).toBeLessThanOrEqual(STATEMENT_WIDTH)
      }
    }
  })

  it('prints a truncated description in full on the line beneath', () => {
    // padColumns is allowed to truncate ONLY because nothing is lost - the
    // untruncated text always appears somewhere in the same document.
    const long = 'Rent, late fee and the utility reconciliation for the whole quarter'
    const text = flat(
      statementBlocks(
        facts({
          lines: [{ ...line('a', 150_000, 1, long), runningBalanceCents: 150_000 }],
        }),
      ),
    )
    expect(text).toContain(long)
  })
})

describe('plain language', () => {
  it('spells out entry types instead of printing enum tokens', () => {
    expect(entryTypeLabel('REVERSAL')).toBe('Correction of an earlier entry')
    expect(entryTypeLabel('PAYMENT')).toBe('Payment received')
    // An unmapped type prints itself rather than a friendly guess, so a value
    // added to the enum and not added here looks unfinished (the repo's own
    // standing trap about widening a status vocabulary).
    expect(entryTypeLabel('ESCROW')).toBe('ESCROW')
  })

  it('shows a credit balance as CR, not as a minus sign', () => {
    expect(balanceLabel(-2_500)).toBe('$25.00 CR')
    expect(balanceLabel(2_500)).toBe('$25.00')
    expect(balanceLabel(0)).toBe('$0.00')
  })

  it('explains CR on the page whenever the account closes in credit', () => {
    const text = textOf(statementBlocks(facts({ closingBalanceCents: -2_500 })))
    expect(text).toContain('money held on the tenant')
  })

  it('says outright that a period is empty', () => {
    const text = textOf(statementBlocks(facts()))
    expect(text).toContain('No charges or payments are recorded')
  })
})

describe('corrections', () => {
  it('marks both sides of a reversal and never hides the original', () => {
    // D-11 forbids editing history, so a reader must be able to see the
    // mistake AND the fix. Showing only the correction would be a tidied
    // history, which is the thing the append-only ledger exists to prevent.
    const original = { ...line('orig', 5_000, 1, 'Late fee'), runningBalanceCents: 5_000 }
    const reversal = {
      ...line('rev', -5_000, 2, 'Late fee reversed'),
      type: 'REVERSAL',
      reversesId: 'orig',
      runningBalanceCents: 0,
    }
    const text = flat(statementBlocks(facts({ lines: [original, reversal] })))

    expect(text).toContain('Late fee')
    expect(text).toContain('this entry was later corrected')
    expect(text).toContain('corrects an earlier entry in this statement')
  })
})

describe('underlying records', () => {
  const withInvoice = {
    ...line('a', 150_000, 1, 'Rent — March'),
    runningBalanceCents: 150_000,
  }

  it('cites the invoice behind a line', () => {
    const text = textOf(
      statementBlocks(
        facts({ lines: [withInvoice], attachedInvoiceIds: ['in_123'] }),
        () => 'in_123',
      ),
    )
    expect(text).toContain('Stripe invoice in_123')
    expect(text).toContain('appended to this document in full')
  })

  it('NAMES an invoice it could not attach rather than staying silent', () => {
    // The whole reason the section exists. A statement one attachment short
    // with no note reads as "there was no invoice for that line" - a
    // different and false claim.
    const text = textOf(
      statementBlocks(
        facts({ lines: [withInvoice], unattachedInvoiceIds: ['in_999'] }),
        () => 'in_999',
      ),
    )
    expect(text).toContain('could not be retrieved')
    expect(text).toContain('in_999')
  })

  it('omits the section entirely when no invoice is involved', () => {
    const text = textOf(statementBlocks(facts({ lines: [withInvoice] })))
    expect(text).not.toContain('Underlying records')
  })
})
