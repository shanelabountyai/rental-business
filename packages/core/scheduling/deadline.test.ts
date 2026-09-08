import { describe, expect, it } from 'vitest'
import {
  type DayCountRule,
  UNREVIEWED_DAY_COUNT,
  dayCountNote,
  isBusinessDay,
  statutoryDeadline,
} from './deadline.ts'

// R-182 (review finding 14). The whole point of this module is that a wrong
// deadline here is invisible — nothing throws, a date comes back, and it is
// the wrong day for somebody's cure period or deposit return. So every branch
// gets a case with a hand-checked calendar date, not a computed expectation.
//
// 2026-09-05 is a Saturday, 2026-09-06 a Sunday, 2026-09-07 the first Monday
// in September (Labor Day). That three-day run is what most of these use.

const CALENDAR: DayCountRule = { dayCountBasis: 'CALENDAR', observedHolidays: [] }
const ROLL: DayCountRule = {
  dayCountBasis: 'CALENDAR_ROLL_FORWARD',
  observedHolidays: ['2026-09-07'],
}
const BUSINESS: DayCountRule = {
  dayCountBasis: 'BUSINESS',
  observedHolidays: ['2026-09-07'],
}

describe('isBusinessDay', () => {
  it('excludes the weekend and the observed holiday, keeps the ordinary weekday', () => {
    expect(isBusinessDay('2026-09-04', ROLL)).toBe(true) // Friday
    expect(isBusinessDay('2026-09-05', ROLL)).toBe(false) // Saturday
    expect(isBusinessDay('2026-09-06', ROLL)).toBe(false) // Sunday
    expect(isBusinessDay('2026-09-07', ROLL)).toBe(false) // Labor Day
    expect(isBusinessDay('2026-09-08', ROLL)).toBe(true) // Tuesday
  })

  it('treats a holiday nobody configured as an ordinary working day', () => {
    // Not a bug: an empty list is the absence of a claim, and a CALENDAR
    // state never reads it at all. It IS why `computeCoverage` has to say
    // out loud when a business-day state has no holidays on file.
    expect(isBusinessDay('2026-09-07', CALENDAR)).toBe(true)
  })
})

describe('statutoryDeadline', () => {
  it('CALENDAR lands where it lands, weekend or holiday', () => {
    // Friday + 3 = Monday 7 September, which is Labor Day. Texas.
    expect(statutoryDeadline('2026-09-04', 3, CALENDAR)).toBe('2026-09-07')
    expect(statutoryDeadline('2026-09-02', 3, CALENDAR)).toBe('2026-09-05')
  })

  it('an unreviewed rule counts as calendar — the pre-R-182 behaviour, unchanged', () => {
    // Load-bearing. Null means nobody has reviewed the state, and this
    // shipping as anything else would have moved every deadline already
    // running in the deployment (D-12).
    expect(statutoryDeadline('2026-09-04', 3, UNREVIEWED_DAY_COUNT)).toBe(
      statutoryDeadline('2026-09-04', 3, CALENDAR),
    )
  })

  it('CALENDAR_ROLL_FORWARD walks a weekend-or-holiday landing to the next working day', () => {
    // + 3 lands on Labor Day, rolls past it to Tuesday.
    expect(statutoryDeadline('2026-09-04', 3, ROLL)).toBe('2026-09-08')
    // + 1 lands on Saturday and has to clear the whole three-day run.
    expect(statutoryDeadline('2026-09-04', 1, ROLL)).toBe('2026-09-08')
    // An ordinary landing is untouched.
    expect(statutoryDeadline('2026-09-01', 2, ROLL)).toBe('2026-09-03')
  })

  it('BUSINESS does not count the weekend or the holiday at all', () => {
    // Friday + 1 business day is Tuesday: Saturday, Sunday and Labor Day
    // are not days for this purpose.
    expect(statutoryDeadline('2026-09-04', 1, BUSINESS)).toBe('2026-09-08')
    // Friday + 3 business days: Tue 8, Wed 9, Thu 10.
    expect(statutoryDeadline('2026-09-04', 3, BUSINESS)).toBe('2026-09-10')
    // And it is genuinely shorter under CALENDAR, which is the defect this
    // item exists to fix — the same statute, three days apart.
    expect(statutoryDeadline('2026-09-04', 3, CALENDAR)).toBe('2026-09-07')
  })

  it('BUSINESS counts from a non-business day without giving a free day', () => {
    // Held from Saturday, one business day: Tuesday. The start day is never
    // counted under any basis, so a weekend start does not add one.
    expect(statutoryDeadline('2026-09-05', 1, BUSINESS)).toBe('2026-09-08')
  })

  it('a zero-day period still lands on a working day, and both bases agree', () => {
    // A state where a tenancy ends the day notice is delivered is real
    // configuration (`earlyTermination`'s own note), so a zero-day period
    // starting on a Saturday is reachable. The count loop never runs, so
    // the roll has to happen after it or the two bases disagree about the
    // same day. Under CALENDAR nothing rolls, and that is the whole
    // distinction between the two.
    expect(statutoryDeadline('2026-09-05', 0, BUSINESS)).toBe('2026-09-08')
    expect(statutoryDeadline('2026-09-05', 0, ROLL)).toBe('2026-09-08')
    expect(statutoryDeadline('2026-09-05', 0, CALENDAR)).toBe('2026-09-05')
  })

  it('crosses a month end, a year end and the DST switch as calendar arithmetic', () => {
    expect(statutoryDeadline('2026-12-30', 3, CALENDAR)).toBe('2027-01-02')
    // 2026-03-08 is the US DST switch: 30 * 24h would be off by an hour and
    // therefore by a day.
    expect(statutoryDeadline('2026-03-01', 30, CALENDAR)).toBe('2026-03-31')
    // Business days across the same switch: 2026-03-01 is a Sunday, so 5
    // business days is Mon 2 through Fri 6.
    expect(statutoryDeadline('2026-03-01', 5, BUSINESS)).toBe('2026-03-06')
  })

  it('refuses to count backwards on anything but a calendar basis', () => {
    // Rolling a backwards deadline forward would EXTEND it, and no statute
    // in this product runs backwards today. Refusing beats inventing a rule.
    expect(statutoryDeadline('2026-09-08', -3, CALENDAR)).toBe('2026-09-05')
    expect(() => statutoryDeadline('2026-09-08', -3, BUSINESS)).toThrow(RangeError)
    expect(() => statutoryDeadline('2026-09-08', -3, ROLL)).toThrow(RangeError)
  })
})

describe('dayCountNote', () => {
  it('says nothing at all for an unreviewed state', () => {
    // Not "calendar days" — that is the assertion the third state exists to
    // avoid making on nobody's behalf.
    expect(dayCountNote(UNREVIEWED_DAY_COUNT)).toBeNull()
    expect(dayCountNote(BUSINESS)).toContain('business days')
  })
})
