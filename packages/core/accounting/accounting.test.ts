import { describe, expect, it } from 'vitest'
import {
  AccountingError,
  buildJournalEntry,
  type JournalFact,
  postOnce,
  SimulatedAccountingAdapter,
} from './index.ts'

const day = { docNumber: 'P1-20261104-1', txnDate: '2026-11-04', propertyId: 'prop_1' }

// Accrual-shaped facts (D-393): rent billed, paid, and a late fee reversed.
const facts: JournalFact[] = [
  { ledgerEntryId: 'le_rent', debit: 'ACCOUNTS_RECEIVABLE', credit: 'RENTAL_INCOME', amountCents: 150_000 },
  { ledgerEntryId: 'le_pay', debit: 'UNDEPOSITED_FUNDS', credit: 'ACCOUNTS_RECEIVABLE', amountCents: 150_000 },
  { ledgerEntryId: 'le_fee', debit: 'ACCOUNTS_RECEIVABLE', credit: 'LATE_FEE_INCOME', amountCents: 7_500 },
  { ledgerEntryId: 'le_fee_rev', debit: 'ACCOUNTS_RECEIVABLE', credit: 'LATE_FEE_INCOME', amountCents: -7_500 },
]

describe('buildJournalEntry', () => {
  it('balances, keeps reversals as their own lines, and links every entry', () => {
    const entry = buildJournalEntry({ ...day, facts })!
    const total = (side: string) =>
      entry.lines.filter((l) => l.side === side).reduce((n, l) => n + l.amountCents, 0)
    expect(total('DEBIT')).toBe(total('CREDIT'))
    // The reversed fee is not netted away: it appears on both sides.
    expect(entry.lines).toContainEqual({ account: 'LATE_FEE_INCOME', side: 'CREDIT', amountCents: 7_500 })
    expect(entry.lines).toContainEqual({ account: 'LATE_FEE_INCOME', side: 'DEBIT', amountCents: 7_500 })
    expect(entry.lines.every((l) => l.amountCents > 0)).toBe(true)
    expect(entry.ledgerEntryIds).toEqual(['le_rent', 'le_pay', 'le_fee', 'le_fee_rev'])
  })

  it('returns null for a day of zero-amount facts, and refuses bad input', () => {
    const zero = { ...facts[0]!, amountCents: 0 }
    expect(buildJournalEntry({ ...day, facts: [zero] })).toBeNull()
    expect(() => buildJournalEntry({ ...day, facts: [{ ...zero, amountCents: 1.5 }] })).toThrow(RangeError)
    expect(() =>
      buildJournalEntry({ ...day, facts: [{ ...zero, amountCents: 1, credit: 'ACCOUNTS_RECEIVABLE' }] }),
    ).toThrow(RangeError)
    expect(() => buildJournalEntry({ ...day, docNumber: 'x'.repeat(22), facts })).toThrow(RangeError)
  })
})

describe('postOnce against the simulated company file', () => {
  it('a lost response then a retry posts exactly once', async () => {
    let lose = true
    const qbo = new SimulatedAccountingAdapter({
      fault: (op) => (op === 'post' && lose ? 'partial_failure' : null),
    })
    const entry = buildJournalEntry({ ...day, facts })!

    await expect(postOnce(qbo, entry)).rejects.toBeInstanceOf(AccountingError)
    lose = false
    const retried = await postOnce(qbo, entry)

    expect(qbo.posted).toHaveLength(1)
    expect(retried.externalId).toBe(qbo.posted[0]!.externalId)
  })

  it('a timeout posts nothing, and a bare repost duplicates as QuickBooks would', async () => {
    let fault: 'timeout' | null = 'timeout'
    const qbo = new SimulatedAccountingAdapter({ fault: (op) => (op === 'post' ? fault : null) })
    const entry = buildJournalEntry({ ...day, facts })!
    await expect(qbo.postJournalEntry(entry)).rejects.toMatchObject({ code: 'timeout' })
    expect(qbo.posted).toHaveLength(0)

    fault = null
    await qbo.postJournalEntry(entry)
    await qbo.postJournalEntry(entry)
    expect(qbo.posted).toHaveLength(2) // why postOnce exists
  })
})
