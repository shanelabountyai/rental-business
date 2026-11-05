import { describe, expect, it } from 'vitest'
import {
  AccountingError,
  buildJournalEntry,
  classifyLedgerEntry,
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
    const entry = { ...buildJournalEntry({ ...day, facts })!, ...refs }
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

const refs = {
  accounts: {},
  property: { id: 'class_1', name: 'Prop 1', field: 'CLASS' as const },
}

describe('postOnce against the simulated company file', () => {
  it('a lost response then a retry posts exactly once', async () => {
    let lose = true
    const qbo = new SimulatedAccountingAdapter({
      fault: (op) => (op === 'post' && lose ? 'partial_failure' : null),
    })
    const entry = { ...buildJournalEntry({ ...day, facts })!, ...refs }

    await expect(postOnce(qbo, entry)).rejects.toBeInstanceOf(AccountingError)
    lose = false
    const retried = await postOnce(qbo, entry)

    expect(qbo.posted).toHaveLength(1)
    expect(retried.externalId).toBe(qbo.posted[0]!.externalId)
  })

  it('a timeout posts nothing, and a bare repost duplicates as QuickBooks would', async () => {
    let fault: 'timeout' | null = 'timeout'
    const qbo = new SimulatedAccountingAdapter({ fault: (op) => (op === 'post' ? fault : null) })
    const entry = { ...buildJournalEntry({ ...day, facts })!, ...refs }
    await expect(qbo.postJournalEntry(entry)).rejects.toMatchObject({ code: 'timeout' })
    expect(qbo.posted).toHaveLength(0)

    fault = null
    await qbo.postJournalEntry(entry)
    await qbo.postJournalEntry(entry)
    expect(qbo.posted).toHaveLength(2) // why postOnce exists
  })
})

// R-282a: one ledger row, both bases. Signs are the tenant balance's.
describe('classifyLedgerEntry', () => {
  const row = (over: Partial<Parameters<typeof classifyLedgerEntry>[0]>) => ({
    id: 'le', type: 'CHARGE' as const, amountCents: 150_000, paymentId: null, chargeType: null, ...over,
  })
  const fact = (r: ReturnType<typeof row>, basis: 'CASH' | 'ACCRUAL') => {
    const c = classifyLedgerEntry(r, basis)
    return c.kind === 'fact' ? c.fact : c.kind
  }

  it('books unlinked subscription rent to A/R on accrual and not at all on cash', () => {
    expect(fact(row({}), 'ACCRUAL')).toMatchObject({ debit: 'ACCOUNTS_RECEIVABLE', credit: 'RENTAL_INCOME', amountCents: 150_000 })
    expect(fact(row({}), 'CASH')).toBe('not_on_basis')
  })

  it('clears A/R with a payment on accrual and credits income directly on cash', () => {
    const pay = row({ type: 'PAYMENT', amountCents: -5_000, paymentId: 'p1', chargeType: 'LATE_FEE' })
    expect(fact(pay, 'ACCRUAL')).toMatchObject({ debit: 'UNDEPOSITED_FUNDS', credit: 'ACCOUNTS_RECEIVABLE', amountCents: 5_000 })
    expect(fact(pay, 'CASH')).toMatchObject({ debit: 'UNDEPOSITED_FUNDS', credit: 'LATE_FEE_INCOME', amountCents: 5_000 })
  })

  it('treats a PAYMENT row with no Payment as money, never as an obligation', () => {
    const orphan = row({ type: 'PAYMENT', amountCents: -1_000 })
    expect(fact(orphan, 'ACCRUAL')).toMatchObject({ debit: 'UNDEPOSITED_FUNDS', amountCents: 1_000 })
    expect(fact(orphan, 'CASH')).toMatchObject({ debit: 'UNDEPOSITED_FUNDS', credit: 'RENTAL_INCOME' })
  })

  it('posts a returned payment and a voided charge as negative amounts, which swap the sides', () => {
    const returned = row({ type: 'REVERSAL', amountCents: 150_000, paymentId: 'p1' })
    expect(fact(returned, 'CASH')).toMatchObject({ debit: 'UNDEPOSITED_FUNDS', credit: 'RENTAL_INCOME', amountCents: -150_000 })
    const voided = row({ type: 'REVERSAL', amountCents: -150_000 })
    expect(fact(voided, 'ACCRUAL')).toMatchObject({ debit: 'ACCOUNTS_RECEIVABLE', credit: 'RENTAL_INCOME', amountCents: -150_000 })
    expect(fact(voided, 'CASH')).toBe('not_on_basis')
  })

  it('keeps a security deposit a liability on both bases (Q7)', () => {
    const paid = row({ type: 'PAYMENT', amountCents: -200_000, paymentId: 'p2', chargeType: 'DEPOSIT' })
    expect(fact(paid, 'CASH')).toMatchObject({ credit: 'SECURITY_DEPOSITS_HELD' })
    expect(fact(row({ chargeType: 'DEPOSIT' }), 'ACCRUAL')).toMatchObject({ credit: 'SECURITY_DEPOSITS_HELD' })
  })

  it('excludes ledger-only adjustments and unclassified charges on both bases, with a reason', () => {
    for (const basis of ['CASH', 'ACCRUAL'] as const) {
      expect(classifyLedgerEntry(row({ type: 'ADJUSTMENT', amountCents: 3_000 }), basis)).toMatchObject({ kind: 'excluded', reason: /D-306/ })
      expect(classifyLedgerEntry(row({ chargeType: 'OTHER', paymentId: 'p3' }), basis)).toMatchObject({ kind: 'excluded' })
    }
  })

  it('a charge and its payment on accrual net A/R to zero and leave income and cash', () => {
    const entry = buildJournalEntry({
      ...day,
      facts: [row({ id: 'c' }), row({ id: 'p', type: 'PAYMENT', amountCents: -150_000, paymentId: 'p1' })].map(
        (r) => (classifyLedgerEntry(r, 'ACCRUAL') as { fact: JournalFact }).fact,
      ),
    })!
    expect(entry.lines).toEqual([
      { account: 'ACCOUNTS_RECEIVABLE', side: 'CREDIT', amountCents: 150_000 },
      { account: 'RENTAL_INCOME', side: 'CREDIT', amountCents: 150_000 },
      { account: 'ACCOUNTS_RECEIVABLE', side: 'DEBIT', amountCents: 150_000 },
      { account: 'UNDEPOSITED_FUNDS', side: 'DEBIT', amountCents: 150_000 },
    ])
  })
})
