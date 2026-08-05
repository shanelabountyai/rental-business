// Quiet hours (NOTIF-05: "quiet hours respected except emergencies").
//
// Property-local, per D-3, for the same reason every nightly job is: 9pm in
// Houston is 7pm in Honolulu, and a reminder that respects quiet hours in UTC
// respects them in exactly one timezone.
//
// Quiet hours DEFER, they do not discard. A rent reminder that would have
// gone out at 21:30 goes out at 08:00 the next morning instead - dropping it
// would silently lose a notification the product promised to send, which is a
// worse failure than a late one and much harder to notice.

import { localParts } from '../scheduling/local-time.ts'

export interface QuietHours {
  /// Local hour quiet time begins, 0-23. Inclusive.
  startHour: number
  /// Local hour quiet time ends, 0-23. Exclusive - sending resumes at this hour.
  endHour: number
}

/**
 * 21:00-08:00 local. A product default, not a statutory one: the TCPA's
 * 8am-9pm window is the closest thing to a rule here and applies to
 * telemarketing rather than to an existing business relationship, so this is
 * the conservative common-practice choice and not a citation - the same
 * posture R-010 takes toward its seeded jurisdiction numbers.
 *
 * Not yet per-property configurable. Whichever item first has an operator ask
 * for that adds a column and reads it here; nothing else has to change,
 * because every caller already goes through these two functions.
 */
export const DEFAULT_QUIET_HOURS: QuietHours = { startHour: 21, endHour: 8 }

/// Handles the ordinary overnight window (21 -> 8, wrapping midnight) and the
/// degenerate same-day one (13 -> 17) without the caller caring which it has.
function hourIsQuiet(hour: number, quiet: QuietHours): boolean {
  return quiet.startHour > quiet.endHour
    ? hour >= quiet.startHour || hour < quiet.endHour
    : hour >= quiet.startHour && hour < quiet.endHour
}

export function withinQuietHours(
  instant: Date,
  timeZone: string,
  quiet: QuietHours = DEFAULT_QUIET_HOURS,
): boolean {
  return hourIsQuiet(localParts(instant, timeZone).hour, quiet)
}

/**
 * The next instant sending may resume, for a notification that arrived during
 * quiet hours.
 *
 * Computed by stepping forward hour by hour from `instant` and asking the
 * timezone itself when the local clock reaches `endHour` - rather than by
 * constructing a local timestamp and converting it back, which is where DST
 * bugs live. Quiet windows are under 24 hours by construction, so this
 * terminates within a day's worth of steps and never needs offset arithmetic
 * this module would have to keep correct across a transition.
 */
export function quietHoursEndAfter(
  instant: Date,
  timeZone: string,
  quiet: QuietHours = DEFAULT_QUIET_HOURS,
): Date {
  const HOUR_MS = 60 * 60 * 1000
  // Start from the top of the current local hour so the result is a clean
  // boundary rather than 08:37 because that is when the job happened to run.
  const parts = localParts(instant, timeZone)
  let cursor = new Date(instant.getTime() - parts.minute * 60 * 1000)
  cursor = new Date(cursor.getTime() - (cursor.getSeconds() * 1000 + cursor.getMilliseconds()))

  // 26 steps, not 24: a fall-back day has 25 local hours, and one spare beats
  // an off-by-one that returns the instant unchanged and sends at 3am.
  for (let step = 0; step < 26; step++) {
    cursor = new Date(cursor.getTime() + HOUR_MS)
    if (!withinQuietHours(cursor, timeZone, quiet)) return cursor
  }
  // Unreachable for any window shorter than a day. Returning the cursor
  // rather than throwing keeps a misconfigured window from wedging the whole
  // send path - it sends late, loudly wrong, rather than not at all.
  return cursor
}
