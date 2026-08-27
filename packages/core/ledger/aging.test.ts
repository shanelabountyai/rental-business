import { describe, expect, it } from 'vitest'
import { agingTotals, bucketFor, delinquencyFor } from './aging.ts'
import type { DelinquencyFacts } from './aging.ts'

const owing: DelinquencyFacts = {
  // No dated charge rows, which is the ORDINARY tenancy: D-11/D-40 mint no
  // monthly `Charge` for the subscription's own rent line, so a lease behind
  // on rent alone has none. The charge cases get their own blocks below.
  charges: [],
  balanceCents: 150_000,
  asOf: '2026-08-10',
  graceDays: 5,
  nearestRentDueOn: '2026-08-01',
  monthlyRentCents: 150_000,
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

  it('AGES FROM THE OLDEST DEBT THE BALANCE STILL REACHES, not the newest', () => {
    // Two months of arrears: this month's rent plus a utility charge from
    // March that the balance can only be explained by. Taking the newest
    // debt reports the exact opposite, and it is the shape of error that
    // makes a delinquency report worse than no report.
    const result = delinquencyFor({
      ...owing,
      charges: [{ dueOn: '2026-03-01', amountCents: 150_000 }],
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

    it('reports a balance with NOTHING dated at all as unaged, not as zero days late', () => {
      // Real: a manual adjustment with no charge and no lease behind it. It
      // cannot be aged, and pretending it is current-by-age would hide money
      // owed.
      const result = delinquencyFor({ ...owing, charges: [], nearestRentDueOn: null })
      expect(result.balanceCents).toBe(150_000)
      expect(result.oldestDueOn).toBeNull()
      expect(result.pastGrace).toBe(false)
    })
  })

  describe('ordinary rent has no Charge row — the gap R-045 found', () => {
    it('AGES FROM `nearestRentDueOn` WHEN THERE IS NO DATED CHARGE AT ALL', () => {
      // D-11/D-40 mint no monthly Charge for the subscription's own rent
      // line. Before this fix, a lease with a positive balance and no dated
      // charge reported `current` — silently hiding the single most common
      // form of delinquency in the product.
      const result = delinquencyFor({ ...owing, nearestRentDueOn: '2026-07-15' })
      expect(result.oldestDueOn).toBe('2026-07-15')
      expect(result.daysLate).toBe(26)
      expect(result.bucket).toBe('16-30')
    })

    it('A LATE FEE POSTED THIS MORNING DOES NOT RESET THE CLOCK', () => {
      // The exact tenancy R-045 exists for, and it survives R-118's rewrite.
      // Rent has been overdue for a month and a late fee posted TODAY
      // (`Charge.dueOn` is the assessment date, always today or later than
      // the rent it followed). The fee absorbs its own $50 of the balance
      // and the rent underneath takes the rest, so the anchor is the rent
      // due date — not this morning, on the very day the tenancy is
      // accruing fees for being late.
      const result = delinquencyFor({
        ...owing,
        charges: [{ dueOn: '2026-08-10', amountCents: 5_000 }], // the fee, dated today
        nearestRentDueOn: '2026-07-01', // the rent it was assessed on
        balanceCents: 155_000,
      })
      expect(result.oldestDueOn).toBe('2026-07-01')
      expect(result.daysLate).toBe(40)
      expect(result.bucket).toBe('30+')
    })

    it('UNDERSTATES rather than fabricates when more than one month is owed', () => {
      // A documented limitation, not a silent one: `nearestRentDueOn` can
      // only anchor to the MOST RECENT due date, because unlinked rent
      // balance is one number in this schema, not one row per missed
      // period. Two months owed still reports as one month late — better
      // than "current", and the ceiling is stated in the type's own comment
      // rather than left to look more precise than it is.
      const result = delinquencyFor({
        ...owing,
        nearestRentDueOn: '2026-07-01', // the MOST RECENT due date only
        balanceCents: 300_000, // two months owed
      })
      expect(result.daysLate).toBe(40) // dated from July, not June
    })
  })

  describe('a charge row is not evidence the charge is still owed — R-118', () => {
    // `Charge` has no paid marker, so the anchor is ALLOCATED from the
    // balance: payments settle the oldest debt first (D-11), which means
    // whatever is still owed sits on the newest debts.
    const derrick: DelinquencyFacts = {
      // A move-in proration due on 2025-07-03 and paid on time.
      charges: [{ dueOn: '2025-07-03', amountCents: 80_000 }],
      balanceCents: 165_000, // exactly this month's rent
      asOf: '2026-08-27',
      graceDays: 5,
      nearestRentDueOn: '2026-08-07',
      monthlyRentCents: 165_000,
    }

    it('DOES NOT AGE A TENANCY FROM A CHARGE IT PAID A YEAR AGO', () => {
      // Found on R-117's demo walk: this tenant owes exactly one month and
      // the rent roll reported him OVER 30 DAYS, aged from the proration.
      const result = delinquencyFor(derrick)
      expect(result.oldestDueOn).toBe('2026-08-07')
      expect(result.daysLate).toBe(20)
      expect(result.bucket).toBe('16-30')
    })

    it('CANNOT MAKE A TENANT PAST GRACE ON DAY ONE', () => {
      // The consequence that is not cosmetic. `pastGrace` gates who may be
      // chased, and an older anchor can only make it true EARLIER — so
      // under the old reading any tenant with any paid charge on file was
      // chaseable the day after rent was due, whatever the statute allows.
      const result = delinquencyFor({ ...derrick, asOf: '2026-08-08' })
      expect(result.daysLate).toBe(1)
      expect(result.pastGrace).toBe(false)
    })

    it('STILL ANCHORS TO AN OLD CHARGE THE BALANCE CANNOT BE EXPLAINED WITHOUT', () => {
      // The other direction, and the reason this is an allocation and not a
      // deletion: $200 more is owed than this month's rent, and the only
      // debt on file that accounts for it is a utility charge from May.
      const result = delinquencyFor({
        ...derrick,
        charges: [{ dueOn: '2026-05-15', amountCents: 20_000 }],
        balanceCents: 185_000,
      })
      expect(result.oldestDueOn).toBe('2026-05-15')
      expect(result.bucket).toBe('30+')
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
