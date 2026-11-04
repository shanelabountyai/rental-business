// The accounting provider contract (PRD 09 Q12, R-279; D-7 pattern). QuickBooks
// Online is the first real driver (R-280 onward); the simulated adapter below
// is the contract fixture for it, including fault injection.

import type { JournalEntryDraft } from './journal.ts'

/// PRD 00 §14's faults, minus the delayed webhook: this push has no callback.
/// `partial_failure` is the one idempotency exists for - the entry posted and
/// the response was lost, so the caller cannot tell from the error alone.
export const ACCOUNTING_FAULTS = ['timeout', 'malformed_response', 'partial_failure'] as const
export type AccountingFault = (typeof ACCOUNTING_FAULTS)[number]

export class AccountingError extends Error {
  readonly code: AccountingFault

  constructor(code: AccountingFault, message: string) {
    super(message)
    this.name = 'AccountingError'
    this.code = code
  }
}

export interface PostedJournalEntry {
  /// The provider's id. Stored on the sync link (D-312), never invented by us.
  externalId: string
  docNumber: string
}

export interface AccountingAdapter {
  readonly name: string
  /// QuickBooks does not enforce a unique DocNumber, so a retry MUST call
  /// this before `postJournalEntry` (Q5) - posting twice is a duplicate entry
  /// in somebody's books, not an error.
  findJournalEntry(docNumber: string): Promise<PostedJournalEntry | null>
  postJournalEntry(entry: JournalEntryDraft): Promise<PostedJournalEntry>
}

/**
 * Look the DocNumber up first and post only if it is not there. The one
 * sequence every caller must use; the sync job (R-282) does not re-derive it.
 */
export async function postOnce(
  adapter: AccountingAdapter,
  entry: JournalEntryDraft,
): Promise<PostedJournalEntry> {
  return (await adapter.findJournalEntry(entry.docNumber)) ?? adapter.postJournalEntry(entry)
}
