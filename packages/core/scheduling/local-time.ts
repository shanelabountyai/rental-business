// Property-local scheduling (D-3): "Every nightly job runs per-property in
// property-local time - a late fee assessed at UTC midnight is a wrong late fee
// in every timezone west of London."
//
// THE CENTRAL DESIGN CHOICE: jobs are DUE-BASED, not TICK-BASED.
//
// The obvious implementation asks "is the local hour exactly 2 right now?" and
// runs the job when it is. That is wrong twice a year, in both directions:
//
//   Spring forward - 02:00 does not happen at all in America/Chicago on
//   2026-03-08. A job scheduled for 02:00 silently never runs, and nobody
//   notices until a month of late fees is missing.
//
//   Fall back - 01:00 happens twice on 2026-11-01. A job scheduled for 01:00
//   runs twice, and posts every charge twice.
//
// So the question this module answers is "has the local clock reached the
// target hour on today's local date?", and the caller pairs that with a
// uniqueness constraint on (job, property, businessDate). Together those give a
// job that runs exactly once per property per local day, survives both DST
// transitions, and catches up by itself if a cron tick is late or missed.
//
// All of this is Intl, which is standard library. No timezone dependency, no
// tzdata to keep patched - Node ships full ICU.

/// A property-local calendar day as `YYYY-MM-DD`. Deliberately a string and
/// not a Date: a Date is an instant, and "the 3rd in Houston" is not one.
export type BusinessDate = string

export interface LocalParts {
  businessDate: BusinessDate
  hour: number
  minute: number
}

const partsCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // h23 rather than hour12:false: the latter yields hour "24" for midnight
      // in some ICU versions, which turns a midnight job into a job that is
      // never due.
      hourCycle: 'h23',
    })
    partsCache.set(timeZone, formatter)
  }
  return formatter
}

export class UnknownTimezoneError extends Error {
  // Declared and assigned explicitly rather than as a constructor parameter
  // property. Node's type stripping only ERASES types - it cannot emit the
  // assignment a parameter property implies - and the CLI scripts run under
  // exactly that. See packages/db/prisma/create-owner.mts.
  readonly timezone: string

  constructor(timezone: string) {
    super(
      `"${timezone}" is not a recognised IANA timezone. Property.timezone drives every nightly job (D-3); a bad value must fail loudly rather than silently defaulting to UTC.`,
    )
    this.name = 'UnknownTimezoneError'
    this.timezone = timezone
  }
}

/**
 * Splits an instant into the calendar day and clock time at a property.
 *
 * Throws on an unknown zone rather than falling back to UTC. A property whose
 * timezone is garbage would otherwise get every nightly job at the wrong hour
 * and nothing would ever say so.
 */
export function localParts(instant: Date, timeZone: string): LocalParts {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = formatterFor(timeZone).formatToParts(instant)
  } catch {
    throw new UnknownTimezoneError(timeZone)
  }

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''

  const year = get('year')
  const month = get('month')
  const day = get('day')
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))

  if (!year || Number.isNaN(hour)) throw new UnknownTimezoneError(timeZone)

  return { businessDate: `${year}-${month}-${day}`, hour, minute }
}

/// The property-local calendar day an instant falls on. This is the value that
/// belongs in a `@db.Date` column and in a Task's `businessDate`.
export function businessDate(instant: Date, timeZone: string): BusinessDate {
  return localParts(instant, timeZone).businessDate
}

export interface DueCheck {
  /// Whether the local clock has reached the target hour today.
  due: boolean
  /// The local day this decision belongs to. Pair it with a uniqueness
  /// constraint to make the job run exactly once.
  businessDate: BusinessDate
  localHour: number
}

/**
 * Whether a job targeted at `targetLocalHour` is due at this property now.
 *
 * `>=`, not `===`. That single character is what makes the job survive a
 * skipped DST hour, a late cron tick, a deploy that ate a run, and a cold
 * start that pushed the handler past the top of the hour. The uniqueness
 * constraint on (job, property, businessDate) is what stops `>=` from meaning
 * "runs every hour for the rest of the day".
 *
 * ponytail: a job whose target hour is late in the local day (say 23) and
 * whose cron is down through that hour is skipped for that day rather than
 * caught up on the next - `businessDate` has already rolled over. Acceptable
 * while the cron is hourly and the jobs that matter target the early hours;
 * if a late-day job ever becomes important, have runDueJobs look back one
 * business date as well as at today's.
 */
export function isDue(
  instant: Date,
  timeZone: string,
  targetLocalHour: number,
): DueCheck {
  if (
    !Number.isInteger(targetLocalHour) ||
    targetLocalHour < 0 ||
    targetLocalHour > 23
  ) {
    throw new RangeError(
      `targetLocalHour must be an integer 0-23, got ${targetLocalHour}`,
    )
  }

  const parts = localParts(instant, timeZone)
  return {
    due: parts.hour >= targetLocalHour,
    businessDate: parts.businessDate,
    localHour: parts.hour,
  }
}

/**
 * Converts a business date to the Date value a `@db.Date` column expects.
 *
 * Midnight UTC, deliberately: Postgres `date` has no time and no zone, and
 * Prisma reads the UTC calendar day off whatever Date it is given. Building it
 * from local midnight instead would land on the previous day for any property
 * west of Greenwich - which is the exact bug this module exists to prevent,
 * reintroduced at the storage boundary.
 */
export function businessDateToUtc(date: BusinessDate): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError(`Expected a YYYY-MM-DD business date, got "${date}"`)
  }
  return new Date(`${date}T00:00:00.000Z`)
}

/// The inverse, for reading a `@db.Date` back out.
export function utcToBusinessDate(value: Date): BusinessDate {
  return value.toISOString().slice(0, 10)
}

/**
 * Shifts a business date by whole local days. Calendar arithmetic, not
 * duration arithmetic: adding a day across a DST boundary must land on the
 * next date, not 23 or 25 hours later.
 */
export function addBusinessDays(
  date: BusinessDate,
  days: number,
): BusinessDate {
  const base = businessDateToUtc(date)
  base.setUTCDate(base.getUTCDate() + days)
  return utcToBusinessDate(base)
}

/// Whole days between two business dates, `to - from`.
export function businessDaysBetween(
  from: BusinessDate,
  to: BusinessDate,
): number {
  const ms = businessDateToUtc(to).getTime() - businessDateToUtc(from).getTime()
  return Math.round(ms / 86_400_000)
}
