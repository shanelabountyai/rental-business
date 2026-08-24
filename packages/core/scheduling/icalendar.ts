// An iCalendar feed of the visits scheduled at a staff member's properties
// (NOTIF-06, R-097c). Pure - no database, no Next.js, no clock of its own.
//
// ==========================================================================
// AN .ICS SUBSCRIPTION, NOT A CALENDAR VENDOR'S API, and the choice is most
// of what this item decided.
//
// The obvious build is OAuth against Google Calendar, then Outlook, then
// iCloud - three integrations, three token refresh paths, three sets of
// scopes to be granted by somebody who then owns a permission they can
// revoke by accident. RFC 5545 subscription is a feature every one of those
// calendars already has: one URL, no install, no consent screen, and the
// staff member's own calendar app does the polling.
//
// AND IT MAKES TWO-WAY IMPOSSIBLE BY CONSTRUCTION, which is the safe
// direction rather than a limitation. R-097c's own row says a wrong
// conflict policy silently moves a legally-noticed entry appointment
// (R-027), which is a compliance failure and not a sync bug. A read-only
// feed has no conflict policy because it has nothing to conflict with.
//
// WHAT IT COSTS, NAMED: the calendar app decides when to refetch, and
// Google in particular is unhurried about it - measured in hours, not
// minutes. So this is where the day's visits come from, and it is NOT where
// an urgent change is learned; that is what the notification engine is for.
// ==========================================================================

/// One line ending, and it is CRLF because RFC 5545 §3.1 says so. Several
/// parsers are forgiving about it and at least one common one is not.
const CRLF = '\r\n'

/**
 * Escapes a TEXT value (RFC 5545 §3.3.11).
 *
 * BACKSLASH FIRST, or every escape this function adds gets escaped again by
 * the rules below it. The classic ordering bug, and it shows up as visible
 * backslashes in somebody's calendar rather than as an error.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Folds a content line to 75 octets (RFC 5545 §3.1).
 *
 * OCTETS, NOT CHARACTERS, which is why this walks a Buffer-free UTF-8
 * length rather than `slice`. An address with an accented character is
 * common enough that a character-counted fold would eventually split a
 * multi-byte sequence and produce mojibake in somebody's calendar.
 */
export function foldIcsLine(line: string): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line

  const parts: string[] = []
  let start = 0
  while (start < bytes.length) {
    // 75 on the first line; 74 afterwards, because a folded line carries a
    // leading space that counts toward the limit.
    const limit = parts.length === 0 ? 75 : 74
    let end = Math.min(start + limit, bytes.length)
    // Never split a UTF-8 continuation byte (10xxxxxx) from its leader.
    while (end > start && end < bytes.length && (bytes[end]! & 0b1100_0000) === 0b1000_0000) {
      end -= 1
    }
    parts.push(new TextDecoder().decode(bytes.slice(start, end)))
    start = end
  }
  return parts.join(`${CRLF} `)
}

/// `YYYYMMDDTHHMMSSZ` - UTC, always. A floating local time would be read in
/// whichever timezone the reader's phone happens to be in, which for a
/// portfolio spanning zones (D-3) is a visit at the wrong hour.
export function icsInstant(at: Date): string {
  return `${at.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
}

export interface CalendarEvent {
  /// Stable across regenerations of the feed - the same visit must not
  /// arrive as a second entry tomorrow. Built from the row's own id.
  uid: string
  start: Date
  end: Date
  summary: string
  location: string
  description: string
}

export interface CalendarFeed {
  name: string
  events: readonly CalendarEvent[]
  /// When this feed was generated. Passed in rather than read from a clock,
  /// so the tests can assert the whole document.
  generatedAt: Date
}

/**
 * The whole document.
 *
 * `X-WR-CALNAME` is not in RFC 5545 and is honoured by every calendar that
 * matters; without it a subscribed feed is named after its URL, which is a
 * token.
 */
export function icalendarFeed(feed: CalendarFeed): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rental Operations//Visit calendar//EN',
    'CALSCALE:GREGORIAN',
    // A published feed is not an invitation: nobody is being asked to
    // accept, and a calendar that treated it as one would put RSVP buttons
    // on somebody else's appointment.
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(feed.name)}`,
  ]

  for (const event of feed.events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeIcsText(event.uid)}`,
      `DTSTAMP:${icsInstant(feed.generatedAt)}`,
      `DTSTART:${icsInstant(event.start)}`,
      `DTEND:${icsInstant(event.end)}`,
      `SUMMARY:${escapeIcsText(event.summary)}`,
      `LOCATION:${escapeIcsText(event.location)}`,
      `DESCRIPTION:${escapeIcsText(event.description)}`,
      END_MARKER,
    )
  }

  lines.push('END:VCALENDAR')
  return `${lines.map(foldIcsLine).join(CRLF)}${CRLF}`
}

const END_MARKER = 'END:VEVENT'
