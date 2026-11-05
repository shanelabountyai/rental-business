// QuickBooks journal entries from the ledger projection (PRD 09 Q12, R-279).
//
// One balanced JournalEntry per posting day per property (D-311), pushed one
// way from `LedgerEntry` (D-310). This file is the pure half: it turns a
// group of already-classified facts into the lines of one entry. Choosing the
// facts - which entries, on which basis (D-393), into which entity's file
// (D-394) - is R-282's sync job, and the account each key maps to in a given
// company file is R-281's mapping. Nothing here talks to QuickBooks.
//
// NO NETTING. A charge and its same-day reversal produce four lines, not
// zero: the CPA sees both events, and an entry whose lines happen to cancel
// still posts rather than silently disappearing (Q4: reversals post as
// reversing lines, never as edits or deletes).

import type { BusinessDate } from '../scheduling/local-time.ts'

/// Platform-side account keys. Each is mapped to an account in the connected
/// company file during onboarding (D-397, `QuickBooksMapping`). The names are
/// PRD 09 §4's proposed defaults, plus one key per income kind R-282a
/// classifies, so a CPA who wants them apart can have them apart.
export const ACCOUNT_DEFAULTS = {
  RENTAL_INCOME: 'Rental Income',
  LATE_FEE_INCOME: 'Late Fee Income',
  FEE_INCOME: 'Fee Income',
  UTILITY_REIMBURSEMENTS: 'Utility Reimbursements',
  TENANT_CHARGEBACKS: 'Tenant Chargebacks',
  RENT_CONCESSIONS: 'Rent Concessions',
  LEGAL_COST_RECOVERY: 'Legal Cost Recovery',
  SECURITY_DEPOSITS_HELD: 'Security Deposits Held',
  ACCOUNTS_RECEIVABLE: 'Accounts Receivable',
  UNDEPOSITED_FUNDS: 'Undeposited Funds',
  MERCHANT_FEES: 'Merchant Fees',
  REPAIRS: 'Repairs and Maintenance',
  MANAGEMENT_FEES: 'Management Fees',
  OWNER_DISTRIBUTIONS: 'Owner Distributions',
} as const

export type AccountKey = keyof typeof ACCOUNT_DEFAULTS

/// One ledger entry, already classified. `amountCents` is positive for the
/// event as it normally happens (debit `debit`, credit `credit`); a reversal
/// carries the original's accounts with a negative amount, which swaps the
/// sides rather than editing anything.
export interface JournalFact {
  ledgerEntryId: string
  debit: AccountKey
  credit: AccountKey
  amountCents: number
}

export interface JournalLine {
  account: AccountKey
  side: 'DEBIT' | 'CREDIT'
  /// Always positive - QuickBooks rejects a negative line amount.
  amountCents: number
}

export interface JournalEntryDraft {
  /// Platform-generated, so a retry can look it up before posting (Q5).
  docNumber: string
  txnDate: BusinessDate
  /// The property every line is tagged with, as a Class or a Location per
  /// the connection's setting (D-395). The adapter decides which field.
  propertyId: string
  lines: JournalLine[]
  /// Every entry the lines account for, so the sync can link each one
  /// (D-312) - including any whose amount was zero.
  ledgerEntryIds: string[]
}

/// QuickBooks Online caps DocNumber at 21 characters.
export const DOC_NUMBER_MAX = 21

/**
 * Build one balanced entry from a day's facts for one property. Returns
 * `null` when every fact is zero: QuickBooks refuses an entry with no lines,
 * and the caller still links the ids so they are not retried forever.
 */
export function buildJournalEntry(input: {
  docNumber: string
  txnDate: BusinessDate
  propertyId: string
  facts: JournalFact[]
}): JournalEntryDraft | null {
  const { docNumber, facts } = input
  if (docNumber.length === 0 || docNumber.length > DOC_NUMBER_MAX) {
    throw new RangeError(`DocNumber must be 1-${DOC_NUMBER_MAX} characters, got "${docNumber}".`)
  }
  const totals = new Map<string, JournalLine>()
  const add = (account: AccountKey, side: JournalLine['side'], cents: number) => {
    const key = `${side}:${account}`
    const line = totals.get(key) ?? { account, side, amountCents: 0 }
    line.amountCents += cents
    totals.set(key, line)
  }
  for (const fact of facts) {
    if (!Number.isInteger(fact.amountCents)) {
      throw new RangeError(`Ledger entry ${fact.ledgerEntryId} is not whole cents.`)
    }
    if (fact.debit === fact.credit) {
      throw new RangeError(`Ledger entry ${fact.ledgerEntryId} debits and credits ${fact.debit}.`)
    }
    if (fact.amountCents === 0) continue
    const cents = Math.abs(fact.amountCents)
    const [debit, credit] = fact.amountCents > 0 ? [fact.debit, fact.credit] : [fact.credit, fact.debit]
    add(debit, 'DEBIT', cents)
    add(credit, 'CREDIT', cents)
  }
  if (totals.size === 0) return null

  const lines = [...totals.values()].sort(
    (a, b) => a.side.localeCompare(b.side) || a.account.localeCompare(b.account),
  )
  const sum = (side: JournalLine['side']) =>
    lines.filter((l) => l.side === side).reduce((n, l) => n + l.amountCents, 0)
  // True by construction; checked anyway because an unbalanced entry is
  // refused by QuickBooks only after the round trip, and this is money.
  if (sum('DEBIT') !== sum('CREDIT')) throw new Error(`Journal entry ${docNumber} does not balance.`)

  return {
    docNumber,
    txnDate: input.txnDate,
    propertyId: input.propertyId,
    lines,
    ledgerEntryIds: facts.map((f) => f.ledgerEntryId),
  }
}
