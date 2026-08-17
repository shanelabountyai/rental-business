// Reading the projection (PAY-03, D-11). Pure - no database.
//
// D-11: `LedgerEntry` is an APPEND-ONLY PROJECTION of Stripe. Nothing here
// writes; everything here is arithmetic over rows that already exist, which
// is why it lives in core and is exhaustively testable without a database.
//
// The signed convention, from the schema's own comment: positive increases
// what is owed, negative reduces it. A balance is therefore just a sum - and
// keeping it a sum, rather than a maintained running total on some other
// table, is what makes the projection checkable against Stripe at all.

import { type Cents, assertCents } from '../money/money.ts'

export interface LedgerRow {
  id: string
  type: string
  amountCents: Cents
  occurredAt: Date
  description: string
  /// Set on a REVERSAL, pointing at the entry it reverses.
  reversesId?: string | null
}

/**
 * What the lease owes right now.
 *
 * Positive means the tenant owes money; negative is a credit balance, which
 * is a real state (an overpayment, a concession) and not an error to clamp
 * away. Clamping it at zero would lose money the tenant has actually paid.
 */
export function balanceCents(rows: readonly LedgerRow[]): Cents {
  let total = 0
  for (const row of rows) {
    assertCents(row.amountCents, `entry ${row.id}`)
    total += row.amountCents
  }
  return total
}

export interface StatementLine extends LedgerRow {
  /// The balance after this entry. What makes a statement readable as a
  /// story rather than a list - PAY-09 wants it "chronological, plain
  /// language, no cryptic codes", because a judge has to read it.
  runningBalanceCents: Cents
}

/**
 * The chronological statement.
 *
 * SORTED HERE, not trusted from the caller, for the same reason R-032's
 * timeline sorts its own entries: the whole value of the document is that it
 * reads in the order things happened, and a caller that forgot would produce
 * a running balance that is arithmetically correct and completely wrong.
 *
 * Ties on `occurredAt` break on id, so two entries stamped the same instant
 * - a payment and the reversal of a prior one arriving in the same webhook
 * batch - always render in the same order.
 */
export function statement(rows: readonly LedgerRow[]): StatementLine[] {
  const sorted = [...rows].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id),
  )
  let running = 0
  return sorted.map((row) => {
    running += row.amountCents
    return { ...row, runningBalanceCents: running }
  })
}

export interface PeriodStatement {
  /// What was owed the instant before the window opened.
  openingBalanceCents: Cents
  lines: StatementLine[]
  /// What was owed at the end of it. Equal to the opening balance when
  /// nothing happened in the window, which is a real and readable outcome.
  closingBalanceCents: Cents
}

/**
 * A statement bounded to a period, with the balance carried forward into it.
 *
 * ==========================================================================
 * THE OPENING BALANCE IS THE WHOLE REASON THIS IS NOT A FILTER.
 *
 * The obvious implementation - filter the rows to the window, then run
 * `statement()` - produces a document that starts every period at zero. For a
 * tenant who entered March owing $500, a March statement would show a closing
 * balance $500 short of what they actually owe, with every line on it
 * arithmetically correct. That is the most dangerous kind of wrong: a court
 * document that is internally consistent and materially false, and nothing on
 * its face reveals it.
 *
 * So the running balance is computed across the tenancy's ENTIRE history and
 * the window is applied afterwards. Every figure printed is therefore the
 * real balance on that date, not a balance relative to an arbitrary start.
 * ==========================================================================
 *
 * `from` and `to` are instants and both are INCLUSIVE, matching how a person
 * asks for "January to March". Pass `null` for either to leave that end open.
 */
export function statementForPeriod(
  rows: readonly LedgerRow[],
  from: Date | null,
  to: Date | null,
): PeriodStatement {
  const all = statement(rows)

  const inWindow = (line: StatementLine) =>
    (from === null || line.occurredAt.getTime() >= from.getTime()) &&
    (to === null || line.occurredAt.getTime() <= to.getTime())

  const lines = all.filter(inWindow)

  // The balance BEFORE the window: the running balance of the last line that
  // precedes it. Read off the already-computed running total rather than
  // re-summing, so the opening figure and the line figures can never be
  // computed two different ways and disagree.
  const before = from === null ? [] : all.filter((line) => line.occurredAt.getTime() < from.getTime())
  const openingBalanceCents = before[before.length - 1]?.runningBalanceCents ?? 0

  return {
    openingBalanceCents,
    lines,
    // Not `balanceCents(rows)`: a statement that closes on 31 March must
    // close at the 31 March balance, even when later entries exist.
    closingBalanceCents:
      lines[lines.length - 1]?.runningBalanceCents ?? openingBalanceCents,
  }
}

/**
 * Entries that have been reversed, and the reversals themselves.
 *
 * Both sides are returned because a statement shows both - D-11 is explicit
 * that "corrections are a new REVERSAL row pointing at the entry it
 * reverses", never an edit or a delete, so the original stays visible and
 * the reader sees what happened rather than a tidied history.
 */
export function reversedEntryIds(rows: readonly LedgerRow[]): Set<string> {
  const reversed = new Set<string>()
  for (const row of rows) {
    if (row.reversesId) reversed.add(row.reversesId)
  }
  return reversed
}
