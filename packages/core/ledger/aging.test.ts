import { describe, expect, it } from 'vitest'
import { agingTotals, bucketFor, delinquencyFor } from './aging.ts'
import type { DelinquencyFacts } from './aging.ts'

const owing: DelinquencyFacts = {
  openCharges: [{ dueOn: '2026-08-01', amountCents: 150_000 }],
  balanceCents: 150_000,
  asOf: '2026-08-10',
  graceDays: 5,
}

describe('bucketFor', () => {
  it('puts a charge due today in `current`, not in the first late bucket', () => {
    // PAY-06 writes the first bucket as "0–5", but a charge due today is not
    // delinquent. Bucketing it with a five-day-old debt would put the whole
    // portfolio on the delinquency tile on the first of the month.
    expect(bucketFor(0)).toBe('current')
    expect(bucketFor(-3)).toBe('current')
  })

  it('walks the boundaries PAY-06 names', () => {
    expect(bucketFor(1)).toBe('0-5')
    expect(bucketFor(5)).toBe('0-5')
    expect(bucketFor(6)).toBe('6-15')
    expect(bucketFor(15)).toBe('6-15')
    expect(bucketFor(16)).toBe('16-30')
    expect(bucketFor(30)).toBe('16-30')
    expect(bucketFor(31)).toBe('30+')
  })
})

describe('delinquencyFor', () => {
  it('ages from the due date and buckets it', () => {
    expect(delinquencyFor(owing)).toEqual({
      balanceCents: 150_000,
      daysLate: 9,
      bucket: '6-15',
      pastGrace: true,
      oldestDueOn: '2026-08-01',
    })
  })

  it('AGES FROM THE OLDEST UNPAID CHARGE, not the newest', () => {
    // A tenant who paid this month while March is still outstanding is five
    // months late, not current. Taking the newest charge reports the exact
    // opposite, and it is the shape of error that makes a delinquency report
    // worse than no report.
    const result = delinquencyFor({
      ...owing,
      openCharges: [
        { dueOn: '2026-08-01', amountCents: 150_000 },
        { dueOn: '2026-03-01', amountCents: 150_000 },
      ],
      balanceCents: 300_000,
    })
    expect(result.oldestDueOn).toBe('2026-03-01')
    expect(result.bucket).toBe('30+')
  })

  describe('past grace is a different question from which bucket', () => {
    it('IS NOT PAST GRACE ON THE LAST DAY OF THE GRACE PERIOD', () => {
      // Five grace days means the tenant HAS five days. Chasing on day five
      // is a day early — the same off-by-one `daysPastDue` was written to
      // kill, one level up.
      const result = delinquencyFor({ ...owing, asOf: '2026-08-06', graceDays: 5 })
      expect(result.daysLate).toBe(5)
      expect(result.pastGrace).toBe(false)
    })

    it('is past grace the day after', () => {
      const result = delinquencyFor({ ...owing, asOf: '2026-08-07', graceDays: 5 })
      expect(result.daysLate).toBe(6)
      expect(result.pastGrace).toBe(true)
    })

    it('IS IN THE FIRST BUCKET AND NOT PAST GRACE AT THE SAME TIME', () => {
      // The case this module exists for. Three days late, five days' grace:
      // visible on the report, and NOT somebody who may be chased. A screen
      // that treats "in a bucket" as "chaseable" is chasing tenants who are
      // not late by the only definition that matters.
      const result = delinquencyFor({ ...owing, asOf: '2026-08-04', graceDays: 5 })
      expect(result.bucket).toBe('0-5')
      expect(result.pastGrace).toBe(false)
    })

    it('NEVER REPORTS PAST GRACE WHEN NO RULE IS CONFIGURED', () => {
      // `graceDays: null` is a state nobody has set up (D-4). "We do not know
      // what the law here allows" must not resolve to "chase them" — the same
      // call assessNsfFee and assessLateFees already make.
      const result = delinquencyFor({ ...owing, asOf: '2026-12-31', graceDays: null })
      expect(result.daysLate).toBeGreaterThan(100)
      expect(result.pastGrace).toBe(false)
    })

    it('treats zero grace days as zero, not as "unconfigured"', () => {
      // A state that genuinely allows chasing on day one is a real
      // configuration, and `null` must not be how it is spelled.
      expect(delinquencyFor({ ...owing, asOf: '2026-08-02', graceDays: 0 }).pastGrace).toBe(true)
    })
  })

  describe('balances that are not debts', () => {
    it('reports a settled account as current', () => {
      expect(delinquencyFor({ ...owing, balanceCents: 0 }).bucket).toBe('current')
    })

    it('REPORTS A CREDIT BALANCE AS CURRENT, not as late', () => {
      // Checked before the charges, so a tenant who has overpaid is never
      // reported late because an old charge row is still on the books.
      const result = delinquencyFor({ ...owing, balanceCents: -5_000 })
      expect(result.bucket).toBe('current')
      expect(result.pastGrace).toBe(false)
      expect(result.daysLate).toBe(0)
    })

    it('reports a balance with no dated charge as unaged, not as zero days late', () => {
      // Real: a manual adjustment, an unlinked Stripe remainder. It cannot be
      // aged, and pretending it is current-by-age would hide money owed.
      const result = delinquencyFor({ ...owing, openCharges: [] })
      expect(result.balanceCents).toBe(150_000)
      expect(result.oldestDueOn).toBeNull()
      expect(result.pastGrace).toBe(false)
    })
  })
})

describe('agingTotals', () => {
  it('sums count and balance per bucket', () => {
    const totals = agingTotals([
      { bucket: '0-5', balanceCents: 100 },
      { bucket: '0-5', balanceCents: 200 },
      { bucket: '30+', balanceCents: 900 },
    ])
    expect(totals['0-5']).toEqual({ count: 2, balanceCents: 300 })
    expect(totals['30+']).toEqual({ count: 1, balanceCents: 900 })
  })

  it('RETURNS EVERY BUCKET EVEN AT ZERO', () => {
    // So a reader can tell "nothing over 30 days" from "we stopped counting".
    // A report that silently omits an empty column is a report somebody
    // misreads as good news.
    const totals = agingTotals([])
    expect(Object.keys(totals)).toEqual(['current', '0-5', '6-15', '16-30', '30+'])
    expect(totals['16-30']).toEqual({ count: 0, balanceCents: 0 })
  })
})
