import { randomBytes } from 'node:crypto'
import {
  type AccountingAdapter,
  type AccountingFault,
  AccountingError,
  type PostableJournalEntry,
  type PostedJournalEntry,
} from './adapter.ts'

// The simulated QuickBooks company file (D-7, R-279).
//
// HOLDS ITS OWN STATE, unlike the syndication simulator, because D-27 asks
// for it here: the entries are what the provider was TOLD, and the lookup
// that makes a retry safe must answer from that, never from our sync table.
// A simulator that read our own links would agree with us by construction,
// and the lost-response branch would be dead code.
//
// DUPLICATE DocNumbers ARE ACCEPTED, as QuickBooks accepts them. Refusing
// them here would hide a caller that skipped the lookup.

export class SimulatedAccountingAdapter implements AccountingAdapter {
  readonly name = 'simulated'
  /// Every entry posted, in order. Public so a test can count duplicates.
  readonly posted: (PostableJournalEntry & { externalId: string })[] = []

  constructor(
    private readonly opts: {
      /// Called before every call; a fault code makes that call throw.
      /// `partial_failure` on a post stores the entry first, then throws.
      fault?: (op: 'find' | 'post', docNumber: string) => AccountingFault | null
    } = {},
  ) {}

  async findJournalEntry(docNumber: string): Promise<PostedJournalEntry | null> {
    this.fail('find', docNumber, this.opts.fault?.('find', docNumber))
    const hit = this.posted.find((e) => e.docNumber === docNumber)
    return hit ? { externalId: hit.externalId, docNumber } : null
  }

  async postJournalEntry(entry: PostableJournalEntry): Promise<PostedJournalEntry> {
    const fault = this.opts.fault?.('post', entry.docNumber)
    if (fault !== 'partial_failure') this.fail('post', entry.docNumber, fault)
    const externalId = randomBytes(4).readUInt32BE().toString()
    this.posted.push({ ...entry, externalId })
    console.info(`[accounting:simulated] posted ${entry.docNumber} as ${externalId}`)
    this.fail('post', entry.docNumber, fault)
    return { externalId, docNumber: entry.docNumber }
  }

  private fail(op: 'find' | 'post', docNumber: string, fault: AccountingFault | null | undefined) {
    if (!fault) return
    console.info(`[accounting:simulated] FAULT (${fault}) on ${op} ${docNumber}`)
    throw new AccountingError(fault, `Simulated ${fault} on ${op} ${docNumber}.`)
  }
}
