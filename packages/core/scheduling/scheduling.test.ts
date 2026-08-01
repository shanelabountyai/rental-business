import { describe, expect, it } from 'vitest'
import {
  UnknownTimezoneError,
  addBusinessDays,
  businessDate,
  businessDateToUtc,
  businessDaysBetween,
  isDue,
  localParts,
  utcToBusinessDate,
} from './local-time.ts'

// Texas is the seeded jurisdiction (D-4), so America/Chicago is the zone most
// of this product runs in. The others are here because the portfolio is
// built per-state configurable and the DST rules differ.
const CHICAGO = 'America/Chicago'
const DENVER = 'America/Denver'
const PHOENIX = 'America/Phoenix' // no DST at all
const HONOLULU = 'Pacific/Honolulu' // no DST, UTC-10

describe('local parts', () => {
  it('reads the calendar day and clock at the property, not in UTC', () => {
    // 03:30 UTC on the 4th is still 21:30 on the 3rd in Houston. A job keyed
    // on the UTC date would file this under the wrong day.
    const instant = new Date('2026-08-04T03:30:00Z')
    expect(localParts(instant, CHICAGO)).toEqual({
      businessDate: '2026-08-03',
      hour: 22,
      minute: 30,
    })
  })

  it('reports midnight as hour 0, never 24', () => {
    // hourCycle h23. With hour12:false some ICU builds emit "24" here, and a
    // midnight job would then never be due.
    const instant = new Date('2026-08-04T05:00:00Z') // 00:00 CDT
    const parts = localParts(instant, CHICAGO)
    expect(parts.hour).toBe(0)
    expect(parts.businessDate).toBe('2026-08-04')
  })

  it('handles a zone that never observes DST', () => {
    const instant = new Date('2026-08-04T03:30:00Z')
    expect(localParts(instant, PHOENIX).hour).toBe(20)
    expect(localParts(instant, HONOLULU).businessDate).toBe('2026-08-03')
  })

  it('refuses an unknown timezone rather than defaulting to UTC', () => {
    // A property whose timezone is garbage would otherwise run every nightly
    // job at the wrong hour, silently, forever.
    expect(() => localParts(new Date(), 'Mars/Olympus_Mons')).toThrow(
      UnknownTimezoneError,
    )
    expect(() => businessDate(new Date(), '')).toThrow(UnknownTimezoneError)
  })
})

// The two days a year that break tick-based scheduling. America/Chicago 2026:
// spring forward 08 March (02:00 -> 03:00), fall back 01 November (02:00 -> 01:00).
describe('DST — spring forward, when the target hour does not exist', () => {
  const SPRING_FORWARD = '2026-03-08'

  it('confirms 02:00 local really is skipped that day', () => {
    // 07:59 UTC is 01:59 CST; one minute later the clock is 03:00 CDT.
    expect(localParts(new Date('2026-03-08T07:59:00Z'), CHICAGO)).toMatchObject({
      businessDate: SPRING_FORWARD,
      hour: 1,
      minute: 59,
    })
    expect(localParts(new Date('2026-03-08T08:00:00Z'), CHICAGO)).toMatchObject({
      businessDate: SPRING_FORWARD,
      hour: 3,
    })
  })

  // The bug this module exists to avoid: an `=== 2` check finds no tick where
  // the hour is 2, so the job silently never runs and a day of late fees is
  // simply missing.
  it('still becomes due for a 02:00 job even though 02:00 never happens', () => {
    const beforeTransition = isDue(
      new Date('2026-03-08T07:00:00Z'),
      CHICAGO,
      2,
    )
    expect(beforeTransition).toMatchObject({
      due: false,
      businessDate: SPRING_FORWARD,
      localHour: 1,
    })

    const afterTransition = isDue(new Date('2026-03-08T08:00:00Z'), CHICAGO, 2)
    expect(afterTransition).toMatchObject({
      due: true,
      businessDate: SPRING_FORWARD,
      localHour: 3,
    })
  })
})

describe('DST — fall back, when the target hour happens twice', () => {
  const FALL_BACK = '2026-11-01'

  it('confirms 01:00 local really does occur twice that day', () => {
    // 06:30 UTC is 01:30 CDT; 07:30 UTC is 01:30 CST. Same wall clock, one
    // hour apart.
    expect(localParts(new Date('2026-11-01T06:30:00Z'), CHICAGO)).toMatchObject({
      businessDate: FALL_BACK,
      hour: 1,
      minute: 30,
    })
    expect(localParts(new Date('2026-11-01T07:30:00Z'), CHICAGO)).toMatchObject({
      businessDate: FALL_BACK,
      hour: 1,
      minute: 30,
    })
  })

  // Both ticks report due, and both report the SAME business date. That is
  // what lets the uniqueness constraint on (job, property, businessDate) turn
  // a double tick into a single run - rather than posting every charge twice.
  it('reports the same business date for both passes through 01:00', () => {
    const first = isDue(new Date('2026-11-01T06:30:00Z'), CHICAGO, 1)
    const second = isDue(new Date('2026-11-01T07:30:00Z'), CHICAGO, 1)

    expect(first.due).toBe(true)
    expect(second.due).toBe(true)
    expect(first.businessDate).toBe(second.businessDate)
    expect(first.businessDate).toBe(FALL_BACK)
  })
})

describe('due checks', () => {
  it('is not due before the target hour and stays due after it', () => {
    const at = (utc: string) => isDue(new Date(utc), CHICAGO, 2).due
    expect(at('2026-08-04T06:00:00Z')).toBe(false) // 01:00 local
    expect(at('2026-08-04T07:00:00Z')).toBe(true) // 02:00 local
    expect(at('2026-08-04T08:00:00Z')).toBe(true) // 03:00 local
    // Stays due for the rest of the local day, which is what makes a missed
    // or late cron tick self-correcting.
    expect(at('2026-08-05T04:00:00Z')).toBe(true) // 23:00 local, same day
  })

  it('rolls over to a fresh business date at local midnight', () => {
    const before = isDue(new Date('2026-08-05T04:59:00Z'), CHICAGO, 2)
    const atMidnight = isDue(new Date('2026-08-05T05:00:00Z'), CHICAGO, 2)
    const atTarget = isDue(new Date('2026-08-05T07:00:00Z'), CHICAGO, 2)

    // 23:59 on the 4th: still the 4th, and that day's job is long since due.
    expect(before).toMatchObject({ businessDate: '2026-08-04', due: true })
    // Midnight starts a new business date, and the new day's job is NOT yet
    // due - the target hour has not arrived. The uniqueness constraint stops
    // matching here, and the due check is what stops the job firing early.
    expect(atMidnight).toMatchObject({ businessDate: '2026-08-05', due: false })
    // 02:00 on the 5th: due, and under a business date no run has claimed.
    expect(atTarget).toMatchObject({ businessDate: '2026-08-05', due: true })
  })

  it('treats a midnight target as due from the first tick of the local day', () => {
    expect(isDue(new Date('2026-08-04T05:00:00Z'), CHICAGO, 0)).toMatchObject({
      due: true,
      localHour: 0,
      businessDate: '2026-08-04',
    })
  })

  // Same instant, three properties, three different answers - which is the
  // whole point of D-3. One UTC-midnight job would have gotten all three
  // wrong in a different way.
  it('gives different answers for different properties at the same instant', () => {
    const instant = new Date('2026-08-04T07:00:00Z')

    // Houston: 02:00 on the 4th. The 4th's job becomes due right now.
    expect(isDue(instant, CHICAGO, 2)).toMatchObject({
      businessDate: '2026-08-04',
      due: true,
      localHour: 2,
    })
    // Denver: 01:00 on the 4th. Same calendar day, but an hour too early.
    expect(isDue(instant, DENVER, 2)).toMatchObject({
      businessDate: '2026-08-04',
      due: false,
      localHour: 1,
    })
    // Honolulu: 21:00 on the THIRD. Its 3rd-of-the-month job has been due for
    // nineteen hours and, if the cron already ran it, is recorded under a
    // business date the other two have not reached yet.
    expect(isDue(instant, HONOLULU, 2)).toMatchObject({
      businessDate: '2026-08-03',
      due: true,
      localHour: 21,
    })
  })

  it.each([-1, 24, 2.5, Number.NaN])(
    'refuses %s as a target hour',
    (hour) => {
      expect(() => isDue(new Date(), CHICAGO, hour)).toThrow(RangeError)
    },
  )
})

describe('business dates at the storage boundary', () => {
  it('round-trips through the value a @db.Date column stores', () => {
    expect(businessDateToUtc('2026-08-04').toISOString()).toBe(
      '2026-08-04T00:00:00.000Z',
    )
    expect(utcToBusinessDate(new Date('2026-08-04T00:00:00Z'))).toBe(
      '2026-08-04',
    )
  })

  // Building the Date from local midnight instead would land on the previous
  // calendar day for every property west of Greenwich - the exact bug this
  // module prevents, reintroduced when the value is written.
  it('does not shift the date for a property west of UTC', () => {
    const local = businessDate(new Date('2026-08-04T07:00:00Z'), CHICAGO)
    expect(local).toBe('2026-08-04')
    expect(utcToBusinessDate(businessDateToUtc(local))).toBe('2026-08-04')
  })

  it('rejects a malformed business date', () => {
    expect(() => businessDateToUtc('4 August 2026')).toThrow(RangeError)
    expect(() => businessDateToUtc('2026-8-4')).toThrow(RangeError)
  })
})

describe('business-date arithmetic', () => {
  it('adds and subtracts whole calendar days', () => {
    expect(addBusinessDays('2026-08-04', 5)).toBe('2026-08-09')
    expect(addBusinessDays('2026-08-04', -4)).toBe('2026-07-31')
  })

  // Calendar arithmetic, not duration arithmetic. Adding a day across the
  // spring-forward boundary must land on the next date, not 23 hours later.
  it('crosses a DST boundary without drifting', () => {
    expect(addBusinessDays('2026-03-07', 1)).toBe('2026-03-08')
    expect(addBusinessDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(addBusinessDays('2026-10-31', 2)).toBe('2026-11-02')
  })

  it('crosses month and year ends', () => {
    expect(addBusinessDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(addBusinessDays('2028-02-28', 1)).toBe('2028-02-29') // leap year
  })

  it('counts whole days between dates', () => {
    expect(businessDaysBetween('2026-08-04', '2026-08-09')).toBe(5)
    expect(businessDaysBetween('2026-08-09', '2026-08-04')).toBe(-5)
    expect(businessDaysBetween('2026-08-04', '2026-08-04')).toBe(0)
    // Grace periods and notice counts are day counts, and a DST week must not
    // come out as 6.96 days rounded wrong.
    expect(businessDaysBetween('2026-03-05', '2026-03-12')).toBe(7)
    expect(businessDaysBetween('2026-10-29', '2026-11-05')).toBe(7)
  })
})
