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
