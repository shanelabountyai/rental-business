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

/// The full IANA set Node's ICU build knows about. Computed once - the list
/// is a few hundred entries and does not change during the process lifetime.
let ianaTimezones: ReadonlySet<string> | null = null

/**
 * Whether `timeZone` is a real IANA identifier, for validating a form field
 * before it ever reaches a Property row. `localParts`/`isDue` already refuse a
 * bad zone at read time (D-3); this lets R-008's create/edit forms refuse it
 * at write time instead, which is the cheaper place to catch it.
 */
export function isValidTimezone(timeZone: string): boolean {
  ianaTimezones ??= new Set(Intl.supportedValuesOf('timeZone'))
  return ianaTimezones.has(timeZone)
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
 * A calendar day in plain language: `1 Sep 2026`.
 *
 * ==========================================================================
 * THE DATE-ONLY TWIN OF `friendlyDate`, AND IT TAKES NO TIMEZONE (R-116).
 *
 * `friendlyDate` formats an INSTANT and requires a zone; a `@db.Date` value
 * must never go through it, because putting a calendar day through a timezone
 * moves it a day west of UTC (R-042's bug). So every screen holding a due
 * date, a lease start or a notice deadline had nowhere to go and printed the
 * ISO string — `Due 2026-09-01` on the tenant pay screen, whose own file
 * header says plain language governs every word here.
 *
 * There is no zone parameter and there must never be one: this value is
 * already the day everybody involved means, and a zone could only move it.
 * The parts are read off the string rather than out of a `Date`, so nothing
 * in here can drift.
 * ==========================================================================
 */
const MONTH_WORDS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  // 'Sept', not 'Sep' - en-GB's own abbreviation for the one month whose
  // short form is four letters, and `friendlyDate` renders it through Intl
  // with that locale. The two readers have to agree or the same day reads
  // differently depending on which screen you are on, which is what R-119
  // hit the moment date-only screens moved off `friendlyDate`.
  'Sept',
  'Oct',
  'Nov',
  'Dec',
]

export function friendlyBusinessDate(date: BusinessDate): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError(`Expected a YYYY-MM-DD business date, got "${date}"`)
  }
  const [year, month, day] = date.split('-')
  return `${Number(day)} ${MONTH_WORDS[Number(month) - 1]} ${year}`
}

/**
 * A property-local wall-clock time ("2026-08-05T14:30", as an
 * `<input type="datetime-local">` submits it) as the UTC instant it names.
 *
 * Added at R-017 for logged call times, and it fixes a real bug rather than
 * tidying one: a `datetime-local` input submits NO timezone, and
 * `Date.parse` on a zone-less string uses the runtime's own zone. On Vercel
 * that is UTC, so a manager in Houston writing up a 14:30 call would have it
 * stored as 14:30 UTC - 09:30 their time. Misdating a contemporaneous note by
 * five hours defeats the entire reason COMM-01 asks for one.
 *
 * Solved by iterating to a fixed point rather than by offset arithmetic: guess
 * that the wall clock is UTC, ask the zone what local time that instant
 * actually is, and correct by the difference. Two passes converge for every
 * real zone including both DST edges, which is why the loop is bounded at two
 * rather than looping until stable - an unbounded version would spin on the
 * one input that has no answer.
 *
 * A time in the spring-forward gap (02:30 on a US spring-forward date) does
 * not exist and cannot be represented; this lands on a nearby real instant
 * rather than throwing, because refusing to log a call over a clock-change
 * technicality would be the worse failure.
 */
export function wallClockToUtc(wallClock: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(
    wallClock,
  )
  if (!match) {
    throw new RangeError(
      `Expected a YYYY-MM-DDTHH:mm wall-clock time, got "${wallClock}"`,
    )
  }
  const [, year, month, day, hour, minute] = match
  const target = Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!)

  let guess = target
  for (let pass = 0; pass < 2; pass++) {
    const parts = localParts(new Date(guess), timeZone)
    const [ly, lm, ld] = parts.businessDate.split('-').map(Number)
    const localAsUtc = Date.UTC(ly!, lm! - 1, ld!, parts.hour, parts.minute)
    const drift = localAsUtc - target
    if (drift === 0) break
    guess -= drift
  }
  return new Date(guess)
}

/**
 * The inverse: a UTC instant as the property-local wall-clock string an
 * `<input type="datetime-local">` expects back.
 */
export function utcToWallClock(instant: Date, timeZone: string): string {
  const parts = localParts(instant, timeZone)
  const hh = String(parts.hour).padStart(2, '0')
  const mm = String(parts.minute).padStart(2, '0')
  return `${parts.businessDate}T${hh}:${mm}`
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

/// The last day of `year`-`month` (1-indexed), for clamping a day-of-month
/// that does not exist that month - the 31st in a 30-day month, the 29th to
/// 31st in February.
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/// The first day of the month `date` falls in.
///
/// Extracted on the third caller, not the first: the dashboard's cash tile
/// and the weekly cash summary had each copied the same
/// `today.split('-')` + `${year}-${month}-01` two-liner, and R-081a's monthly
/// P&L was about to be the third. Pure string work - a calendar day is never
/// converted through a timezone (D-3).
export function startOfMonth(date: BusinessDate): BusinessDate {
  return `${date.slice(0, 7)}-01`
}

/**
 * Every calendar month touched by `[from, to]`, as that month's first day,
 * oldest first.
 *
 * INCLUSIVE AT BOTH ENDS, and a partial month at either end still counts: a
 * range of 28 March to 2 April is two months, because a monthly report that
 * silently dropped March's four days would show a total that does not match
 * its own columns.
 */
export function monthStartsBetween(from: BusinessDate, to: BusinessDate): BusinessDate[] {
  if (from > to) return []
  const months: BusinessDate[] = []
  let cursor = startOfMonth(from)
  const last = startOfMonth(to)
  // Bounded by construction, but a guard costs nothing and a malformed date
  // that never advances would otherwise hang a request.
  while (cursor <= last && months.length < 1200) {
    months.push(cursor)
    const [year, month] = cursor.split('-').map(Number)
    cursor = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`
  }
  return months
}

/**
 * Which calendar day `dueDay` falls on, in `year`-`month`, clamped to the
 * length of that month.
 *
 * A lease due on the 31st is due on the 30th in September and the 28th (or
 * 29th) in February - what "due on the 31st" means to everyone who has ever
 * signed a lease, and the same clamp R-042's proration and R-039a's pre-debit
 * matching already apply, now in one place instead of three.
 */
export function dueDateInMonth(year: number, month: number, dueDay: number): BusinessDate {
  const day = Math.min(dueDay, daysInMonth(year, month))
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * The most recent occurrence of `dueDay` on or before `reference`.
 *
 * ==========================================================================
 * WHAT ANCHORS "HOW LATE IS THIS RENT" WHEN THE RENT HAS NO CHARGE ROW.
 *
 * D-11/D-40 mint no monthly `Charge` for the subscription's own rent line -
 * only for the exceptions (a late fee, a proration, a chargeback). So the
 * ONLY record of when ordinary rent was due is `Lease.rentDueDay` /
 * `LeasePayer.debitDay`, the same pair `predebit.ts` reads to warn an autopay
 * tenant two days ahead. This is the other direction of that same fact:
 * given a day of the month, find the most recent date it fell on.
 *
 * UNDERSTATES LATENESS WHEN MORE THAN ONE PERIOD IS UNPAID. It can only
 * anchor to the MOST RECENT due date - if two months of rent are owed, this
 * returns last month's date, not the one before it, because our schema
 * itemizes no more than "the balance" for unlinked rent (D-11: Stripe holds
 * the per-invoice detail, we hold the projected total). Reporting the nearer
 * date is still a real improvement on reporting "current", and it is stated
 * here rather than left to look more precise than it is. Itemizing every
 * unpaid period would need the billing provider to list every open invoice,
 * not the one `getOpenInvoice` returns today.
 * ==========================================================================
 */
export function dueDateOnOrBefore(reference: BusinessDate, dueDay: number): BusinessDate {
  const [year, month, day] = reference.split('-').map(Number)
  const thisMonth = dueDateInMonth(year, month, dueDay)
  if (day >= Number(thisMonth.slice(8, 10))) return thisMonth
  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear = month === 1 ? year - 1 : year
  return dueDateInMonth(prevYear, prevMonth, dueDay)
}

/**
 * The next occurrence of `dueDay` on or after `reference` - the mirror of
 * `dueDateOnOrBefore`, for "when is rent next due" rather than "how late is
 * it". R-045's due-soon/due-date reminders read this; R-049's `{{balance
 * .due_on}}` merge field is the same computation and now calls this instead
 * of carrying its own copy.
 */
export function dueDateOnOrAfter(reference: BusinessDate, dueDay: number): BusinessDate {
  const [year, month, day] = reference.split('-').map(Number)
  const thisMonth = dueDateInMonth(year, month, dueDay)
  if (day <= Number(thisMonth.slice(8, 10))) return thisMonth
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  return dueDateInMonth(nextYear, nextMonth, dueDay)
}

/**
 * A date a person reads, in the timezone it actually happened in.
 *
 * ==========================================================================
 * `timeZone` IS REQUIRED, AND THAT IS THE ENTIRE POINT.
 *
 * R-101c found four copies of this function across the app. ONE took a
 * timezone; three did not — and `Intl.DateTimeFormat` with no `timeZone`
 * formats in the RUNTIME's zone, which on Vercel is UTC. So a work order
 * closed at 7pm Central on the 14th was shown to staff as the 15th, on the
 * screens where "when did this happen" is the question being asked.
 *
 * Making the parameter required means the broken version cannot be written
 * again: there is no overload that guesses, and no default that silently
 * means UTC. Same discipline as `businessDate` and `utcToBusinessDate`,
 * which exist because a date read through the wrong reader is wrong by a day
 * (R-036b's entry window, R-042's proration).
 *
 * TAKES AN INSTANT, NOT A CALENDAR DAY. A `@db.Date` column comes back as
 * UTC midnight and must NOT come through here — passing one through a
 * timezone moves it a day west of UTC, which is R-042's bug exactly. Use
 * `utcToBusinessDate` for those.
 * ==========================================================================
 */
export function friendlyDate(
  instant: Date,
  timeZone: string,
  options: { month?: 'long' | 'short' } = {},
): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: options.month ?? 'short',
    year: 'numeric',
    timeZone,
  }).format(instant)
}

/**
 * An instant as a property-local timestamp, NAMING THE ZONE: `3 Mar 2026,
 * 09:14 CST`.
 *
 * The zone abbreviation is not decoration (R-052). This is the format the
 * communications transcript and the ledger statement print, and both are
 * documents that leave the building — an adjuster, an attorney or a court
 * reads them somewhere else, on a different clock. "09:14" alone is a time in
 * no particular place, and the whole evidentiary claim of a transcript is
 * that events happened in a specific order at specific moments. Two parties
 * arguing about whether a notice landed before a deadline cannot do it from
 * timestamps with no zone on them.
 *
 * Same instant-not-calendar-day rule as `friendlyDate` above: a `@db.Date`
 * value must never come through here.
 */
export function friendlyTimestamp(instant: Date, timeZone: string): string {
  // `timeZoneName: 'short'` is what appends CST/CDT, and it is why this is
  // one formatter call rather than `friendlyDate` plus a time — the
  // abbreviation has to come from the same resolution that picked the offset,
  // or a document printed on a DST boundary labels the wrong one.
  //
  // `en-US`, NOT the `en-GB` that `friendlyDate` uses, and the difference is
  // the whole reason this is not a one-line wrapper around it. Under `en-GB`,
  // ICU renders an American zone as `GMT-5` rather than `CDT` — technically
  // an offset and useless on a Texas court exhibit, where the reader knows
  // what CDT is and has no reason to convert anything. The day/month/year
  // order is chosen below from the parts, so picking the US locale costs
  // nothing: the output is still `3 Mar 2026`, not `Mar 3, 2026`.
  //
  // `hourCycle: 'h23'` rather than bare `hour12: false` — some ICU builds emit
  // hour "24" for midnight under the latter, which is the same trap
  // `localParts` documents above.
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(instant)

  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? ''

  // THE DATE HALF COMES FROM `friendlyBusinessDate`, NOT FROM THESE PARTS
  // (R-142). Only the clock and the zone are taken from the formatter above,
  // where they have to be: the abbreviation must come from the same
  // resolution that picked the offset.
  //
  // The date could not, because `en-US`'s short September is "Sep" and
  // `en-GB`'s is "Sept" — so this was a THIRD reader of a calendar month and
  // it disagreed with the other two. A compliance due date read
  // "1 Sept 2026" while a transcript entry on the same day read
  // "1 Sep 2026". `scheduling.test.ts` has pinned `friendlyBusinessDate` to
  // `friendlyDate` across all twelve months since R-119; it did not know
  // there was a third to pin. It does now.
  //
  // Delegating rather than indexing `MONTH_WORDS` here is deliberate: three
  // readers sharing an array still leaves three places to get the assembly
  // wrong, and this way there is only one function that turns a calendar day
  // into words. `localParts` resolves that day in the SAME zone, so the two
  // halves of the stamp cannot drift apart.
  const dateHalf = friendlyBusinessDate(localParts(instant, timeZone).businessDate)
  return `${dateHalf}, ${at('hour')}:${at('minute')} ${at('timeZoneName')}`
}

/**
 * Just the clock, property-local: `14:30`.
 *
 * THE FAR END OF A WINDOW, and nothing else. `friendlyTimestamp` opens the
 * window and names the zone; this closes it, so a reader gets
 * "29 Aug 2026, 09:00 CDT to 12:00" rather than the same date printed twice.
 *
 * R-140 wrote this inline in `/vendor/[token]` as `endClockOrNull`; R-141
 * moved it here when the admin work-order page needed the identical thing.
 * The reason it is a function rather than a `.slice(11)` on a wall-clock
 * string is that the positional slice only worked because
 * `utcToWallClock` happens to be fixed-width - it silently produced garbage
 * the moment the stamp above it became a human-readable one.
 *
 * A WINDOW CROSSING MIDNIGHT READS AMBIGUOUSLY HERE - "23:00 CDT to 01:00" -
 * and that is a known ceiling, unchanged from R-140. Entry and viewing
 * windows are a few daylight hours by construction; if one ever legitimately
 * spans a day boundary, this is the call site that has to grow a date.
 */
export function clockTime(instant: Date, timeZone: string): string {
  const { hour, minute } = localParts(instant, timeZone)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
