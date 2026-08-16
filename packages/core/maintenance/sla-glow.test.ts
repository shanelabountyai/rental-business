import { describe, expect, it } from 'vitest'
import { OPEN_TICKET_GLOW_HOURS, ticketGlows } from './sla.ts'

const now = new Date('2026-08-15T12:00:00Z')
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000)

describe('ticketGlows — R-050 dashboard glow, distinct from the first-response clock', () => {
  it('GLOWS an emergency open past 48 hours', () => {
    expect(
      ticketGlows({ priority: 'EMERGENCY', createdAt: hoursAgo(OPEN_TICKET_GLOW_HOURS + 1) }, now),
    ).toBe(true)
  })

  it('glows an urgent ticket too', () => {
    expect(
      ticketGlows({ priority: 'URGENT', createdAt: hoursAgo(OPEN_TICKET_GLOW_HOURS + 1) }, now),
    ).toBe(true)
  })

  it('does NOT glow before the threshold', () => {
    expect(
      ticketGlows({ priority: 'EMERGENCY', createdAt: hoursAgo(OPEN_TICKET_GLOW_HOURS - 1) }, now),
    ).toBe(false)
  })

  it('NEVER GLOWS ROUTINE WORK, however old', () => {
    // Exception-first: routine work sitting open for two days is normal, and
    // flagging it would defeat the whole premise of the tile.
    expect(ticketGlows({ priority: 'ROUTINE', createdAt: hoursAgo(24 * 30) }, now)).toBe(false)
  })

  it('is a DIFFERENT CLOCK from first-response — answered promptly does not stop it', () => {
    // firstResponseSlaState would call this "responded" the moment somebody
    // engages; ticketGlows keeps counting because the JOB is still open,
    // whatever happened to the response clock.
    expect(
      ticketGlows({ priority: 'EMERGENCY', createdAt: hoursAgo(72) }, now),
      'a ticket open 72 hours glows regardless of whether it was ever responded to',
    ).toBe(true)
  })
})
