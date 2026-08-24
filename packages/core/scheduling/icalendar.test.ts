import { describe, expect, it } from 'vitest'
import {
  type CalendarEvent,
  escapeIcsText,
  foldIcsLine,
  icalendarFeed,
  icsInstant,
} from './icalendar.ts'

// The staff visit calendar (NOTIF-06, R-097c).

const event: CalendarEvent = {
  uid: 'showing-abc123@rental',
  start: new Date('2026-09-01T15:00:00Z'),
  end: new Date('2026-09-01T15:30:00Z'),
  summary: 'Showing — 4 Quiet Lane',
  location: '4 Quiet Lane, Houston, TX 77002',
  description: 'Self-serve viewing. The prospect lets themselves in.',
}

describe('escaping', () => {
  it('escapes the backslash FIRST, or every other escape gets escaped again', () => {
    // The classic ordering bug in this function, and it shows up as visible
    // backslashes in somebody's calendar rather than as an error.
    expect(escapeIcsText('a\\b')).toBe('a\\\\b')
    expect(escapeIcsText('4 Quiet Lane, Houston; TX')).toBe('4 Quiet Lane\\, Houston\; TX')
    expect(escapeIcsText('line one\nline two')).toBe('line one\\nline two')
    expect(escapeIcsText('line one\r\nline two')).toBe('line one\\nline two')
  })
})

describe('folding', () => {
  it('leaves a short line alone', () => {
    expect(foldIcsLine('SUMMARY:short')).toBe('SUMMARY:short')
  })

  it('folds at 75 octets with a leading space on the continuation', () => {
    const folded = foldIcsLine(`SUMMARY:${'a'.repeat(200)}`)
    const [first, ...rest] = folded.split('\r\n')
    expect(new TextEncoder().encode(first!).length).toBe(75)
    for (const line of rest) expect(line.startsWith(' ')).toBe(true)
    // Nothing lost: unfolding is removing the CRLF and the one space.
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'a'.repeat(200)}`)
  })

  it('never splits a multi-byte character', () => {
    // OCTETS, not characters. A character-counted fold eventually splits a
    // UTF-8 sequence and produces mojibake in somebody's calendar - an
    // accented street name is common enough to hit it.
    const line = `LOCATION:${'é'.repeat(80)}`
    const folded = foldIcsLine(line)
    expect(folded).not.toContain('�')
    expect(folded.replace(/\r\n /g, '')).toBe(line)
  })
})

describe('timestamps', () => {
  it('writes UTC, always', () => {
    // A floating local time is read in whichever zone the reader's phone is
    // in, which for a portfolio spanning zones (D-3) is a visit at the
    // wrong hour.
    expect(icsInstant(new Date('2026-09-01T15:00:00Z'))).toBe('20260901T150000Z')
  })
})

describe('the feed', () => {
  const feed = icalendarFeed({
    name: 'Visits — Rental Operations',
    events: [event],
    generatedAt: new Date('2026-08-24T09:00:00Z'),
  })

  it('is a well-formed VCALENDAR with CRLF endings', () => {
    // Several parsers forgive a bare LF and at least one common one does not.
    expect(feed.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(feed.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(feed).not.toMatch(/[^\r]\n/)
  })

  it('publishes rather than invites', () => {
    // A calendar treating this as an invitation would put RSVP buttons on
    // somebody else's appointment.
    expect(feed).toContain('METHOD:PUBLISH')
  })

  it('names itself, so a subscription is not named after a token', () => {
    expect(feed).toContain('X-WR-CALNAME:Visits — Rental Operations')
  })

  it('carries every field an event needs, with a stable UID', () => {
    expect(feed).toContain('UID:showing-abc123@rental')
    expect(feed).toContain('DTSTART:20260901T150000Z')
    expect(feed).toContain('DTEND:20260901T153000Z')
    expect(feed).toContain('DTSTAMP:20260824T090000Z')
    // The same visit must not arrive as a second entry tomorrow.
    const again = icalendarFeed({
      name: 'Visits — Rental Operations',
      events: [event],
      generatedAt: new Date('2026-08-25T09:00:00Z'),
    })
    expect(again).toContain('UID:showing-abc123@rental')
  })

  it('renders an empty calendar rather than nothing', () => {
    // A subscription that 404s when there is nothing on is a subscription
    // the calendar app quietly drops.
    const empty = icalendarFeed({ name: 'Visits', events: [], generatedAt: new Date(0) })
    expect(empty).toContain('BEGIN:VCALENDAR')
    expect(empty).toContain('END:VCALENDAR')
    expect(empty).not.toContain('BEGIN:VEVENT')
  })
})
