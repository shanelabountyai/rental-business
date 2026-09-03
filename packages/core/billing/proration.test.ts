import { describe, expect, it } from 'vitest'
import { describeProration, moveInProration, moveOutProration } from './proration.ts'

// The move-in proration (PAY-08, R-042; D-12).
//
// The assertions that matter are arithmetic ones, and the cases that catch
// real bugs are all about WHICH month's length is the divisor and whether the
// first day of the next period gets counted twice.

describe('moveInProration', () => {
  it('prorates a mid-month move-in on the actual days in that month', () => {
    // 20 March to 1 April: the 20th through the 31st inclusive is 12 days of
    // a 31-day month. $1,500 x 12/31 = $580.645..., rounded to $580.65.
    const result = moveInProration({
      monthlyRentCents: 150_000,
      startsOn: '2026-03-20',
      firstFullPeriodStartsOn: '2026-04-01',
      method: 'actual',
    })
    expect(result).not.toBeNull()
    expect(result!.daysOccupied).toBe(12)
    expect(result!.daysInMonth).toBe(31)
    expect(result!.amountCents).toBe(58_065)
  })

  it('uses the MOVE-IN month length, not the length of the period covered', () => {
    // The bug this pins. 20 February to 1 March is 9 days, and the tenant
    // owes 9/28 of the rent. A divisor taken from the covered period (9) would
    // charge a whole month; one taken from the following month (31) would
    // undercharge. Only the move-in month's own length is right.
    const result = moveInProration({
      monthlyRentCents: 150_000,
      startsOn: '2026-02-20',
      firstFullPeriodStartsOn: '2026-03-01',
      method: 'actual',
    })
    expect(result!.daysOccupied).toBe(9)
    expect(result!.daysInMonth).toBe(28)
    expect(result!.amountCents).toBe(48_214)
  })

  it('handles a leap February', () => {
    const result = moveInProration({
      monthlyRentCents: 150_000,
      startsOn: '2028-02-20',
      firstFullPeriodStartsOn: '2028-03-01',
      method: 'actual',
    })
    expect(result!.daysOccupied).toBe(10)
    expect(result!.daysInMonth).toBe(29)
  })

  it('does NOT count the first day of the next period', () => {
    // The classic proration bug: counting the anchor day in both the part
    // month and the full month that follows, so the tenant pays for it twice.
    const result = moveInProration({
      monthlyRentCents: 150_000,
      startsOn: '2026-03-31',
      firstFullPeriodStartsOn: '2026-04-01',
      method: 'actual',
    })
    expect(result!.daysOccupied).toBe(1)
  })

  it('divides by 30 on the banker30 method, whatever the month', () => {
    const result = moveInProration({
      monthlyRentCents: 150_000,
      startsOn: '2026-02-20',
      firstFullPeriodStartsOn: '2026-03-01',
      method: 'banker30',
    })
    // 9 days at $1,500/30 = $50/day = $450.00, even though February is 28.
    expect(result!.amountCents).toBe(45_000)
  })

  it('is NULL when the lease starts exactly on the due day', () => {
    // A whole month is owed and there is nothing to prorate. Returning a
    // zero-amount charge instead would put a meaningless line on the tenant's
    // very first invoice.
    expect(
      moveInProration({
        monthlyRentCents: 150_000,
        startsOn: '2026-04-01',
        firstFullPeriodStartsOn: '2026-04-01',
        method: 'actual',
      }),
    ).toBeNull()
  })

  it('is NULL rather than truncating when the first period exceeds a month', () => {
    // Not a proration at all - it is a lease whose first period is longer
    // than a month. This function has no opinion about that and must not
    // silently charge as though it were 31/31 days.
    expect(
      moveInProration({
        monthlyRentCents: 150_000,
        startsOn: '2026-03-01',
        firstFullPeriodStartsOn: '2026-05-01',
        method: 'actual',
      }),
    ).toBeNull()
  })

  it('is NULL for a backwards range rather than charging a negative rent', () => {
    expect(
      moveInProration({
        monthlyRentCents: 150_000,
        startsOn: '2026-04-10',
        firstFullPeriodStartsOn: '2026-04-01',
        method: 'actual',
      }),
    ).toBeNull()
  })
})

// moveInProration's mirror (R-160). Rent bills a full period in advance, so
// vacating before the period ends owes the tenant back the unoccupied days -
// same arithmetic, run from the other end of the tenancy.
describe('moveOutProration', () => {
  it('credits the unoccupied tail on the actual days in that month', () => {
    // Moves out 20 March, next due day 1 April: the 21st through the 31st is
    // 11 unoccupied days of a 31-day month. $1,500 x 11/31 = $532.258...
    const result = moveOutProration({
      monthlyRentCents: 150_000,
      moveOutOn: '2026-03-20',
      currentPeriodEndsOn: '2026-04-01',
      method: 'actual',
    })
    expect(result).not.toBeNull()
    expect(result!.daysOccupied).toBe(11)
    expect(result!.daysInMonth).toBe(31)
    expect(result!.amountCents).toBe(53_226)
  })

  it('uses the MOVE-OUT month length, not the length of the period covered', () => {
    const result = moveOutProration({
      monthlyRentCents: 150_000,
      moveOutOn: '2026-02-20',
      currentPeriodEndsOn: '2026-03-01',
      method: 'actual',
    })
    expect(result!.daysOccupied).toBe(8)
    expect(result!.daysInMonth).toBe(28)
    expect(result!.amountCents).toBe(42_857)
  })

  it('handles a leap February', () => {
    const result = moveOutProration({
      monthlyRentCents: 150_000,
      moveOutOn: '2028-02-20',
      currentPeriodEndsOn: '2028-03-01',
      method: 'actual',
    })
    expect(result!.daysOccupied).toBe(9)
    expect(result!.daysInMonth).toBe(29)
  })

  it('does NOT credit the move-out day itself', () => {
    // The tenant occupied the 31st, so leaving on the last day of the month
    // owes nothing back - the classic proration bug run in reverse.
    expect(
      moveOutProration({
        monthlyRentCents: 150_000,
        moveOutOn: '2026-03-31',
        currentPeriodEndsOn: '2026-04-01',
        method: 'actual',
      }),
    ).toBeNull()
  })

  it('divides by 30 on the banker30 method, whatever the month', () => {
    const result = moveOutProration({
      monthlyRentCents: 150_000,
      moveOutOn: '2026-02-20',
      currentPeriodEndsOn: '2026-03-01',
      method: 'banker30',
    })
    // 8 unoccupied days at $50/day = $400.00, even though February is 28.
    expect(result!.amountCents).toBe(40_000)
  })

  it('is NULL when moving out exactly on the next due day', () => {
    // The period already billed is the one fully occupied - nothing to
    // give back.
    expect(
      moveOutProration({
        monthlyRentCents: 150_000,
        moveOutOn: '2026-04-01',
        currentPeriodEndsOn: '2026-04-01',
        method: 'actual',
      }),
    ).toBeNull()
  })

  it('is NULL rather than crediting a whole extra month', () => {
    // Not a proration at all if the "period" spans more than a month - this
    // function has no opinion about that and must not silently credit as
    // though it were 60/31 days.
    expect(
      moveOutProration({
        monthlyRentCents: 150_000,
        moveOutOn: '2026-03-01',
        currentPeriodEndsOn: '2026-05-01',
        method: 'actual',
      }),
    ).toBeNull()
  })

  it('is NULL for a backwards range rather than crediting a negative rent', () => {
    expect(
      moveOutProration({
        monthlyRentCents: 150_000,
        moveOutOn: '2026-04-10',
        currentPeriodEndsOn: '2026-04-01',
        method: 'actual',
      }),
    ).toBeNull()
  })
})

describe('describeProration', () => {
  it('shows the arithmetic a tenant can check against a calendar', () => {
    // PAY-08 requires the method to be visible on the ledger. "Proration
    // $580.65" is a number to take on trust; this is one to verify.
    const description = describeProration({
      monthlyRentCents: 150_000,
      daysOccupied: 12,
      daysInMonth: 31,
      method: 'actual',
      amountCents: 58_065,
    })
    expect(description).toContain('$1,500.00')
    expect(description).toContain('12/31 days')
    expect(description).toContain('$580.65')
  })

  it('says so when the 30-day method is in use', () => {
    // Otherwise "9/28 days" and a 30-day answer look like an arithmetic
    // error to anybody checking.
    const description = describeProration({
      monthlyRentCents: 150_000,
      daysOccupied: 9,
      daysInMonth: 28,
      method: 'banker30',
      amountCents: 45_000,
    })
    expect(description).toContain('9/30 days')
    expect(description).toMatch(/30-day month/)
  })

  it('uses the given label — move-out credits, move-in owes', () => {
    const description = describeProration({
      monthlyRentCents: 150_000,
      daysOccupied: 8,
      daysInMonth: 28,
      method: 'actual',
      amountCents: 42_857,
      label: 'Move-out credit',
    })
    expect(description).toMatch(/^Move-out credit —/)
  })
})
