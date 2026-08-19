import { describe, expect, it } from 'vitest'
import { availableShowingSlots } from './showings.ts'

const TZ = 'America/Chicago'
// A Monday, well clear of any DST edge.
const NOW = new Date('2026-08-10T12:00:00Z') // 07:00 America/Chicago

describe('availableShowingSlots', () => {
  it('offers only slots inside the 9am-6pm window, at least minLeadHours out', () => {
    const slots = availableShowingSlots({ now: NOW, timezone: TZ, bookedStarts: [] })
    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) {
      expect(slot.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 2 * 3_600_000)
    }
    // First offered slot today is 09:00 local (14:00 UTC), not 08:00 - the
    // window starts at 9am regardless of how early `now` already clears the
    // lead time.
    expect(slots[0]!.toISOString()).toBe('2026-08-10T14:00:00.000Z')
    // Last slot on day one starts at 17:30 local, never 18:00 - the window
    // is exclusive of its own end.
    const day1 = slots.filter((s) => s.toISOString().startsWith('2026-08-10'))
    expect(day1.at(-1)!.toISOString()).toBe('2026-08-10T22:30:00.000Z') // 17:30 CDT
  })

  it('excludes an exact-match booked start, and nothing else', () => {
    const booked = new Date('2026-08-10T15:00:00.000Z') // 10:00 CDT
    const slots = availableShowingSlots({ now: NOW, timezone: TZ, bookedStarts: [booked] })
    expect(slots.some((s) => s.getTime() === booked.getTime())).toBe(false)
    expect(slots.some((s) => s.getTime() === booked.getTime() + 30 * 60_000)).toBe(true)
  })

  it('an occupied unit offers nothing before the compliant entry-notice start', () => {
    // Notice "served" now, 24h required - nothing before 07:00 tomorrow CDT.
    const earliestStart = new Date(NOW.getTime() + 24 * 3_600_000)
    const slots = availableShowingSlots({
      now: NOW,
      timezone: TZ,
      bookedStarts: [],
      earliestStart,
    })
    for (const slot of slots) {
      expect(slot.getTime()).toBeGreaterThanOrEqual(earliestStart.getTime())
    }
    // Today's slots are gone entirely - even 17:30 CDT today is short of
    // 24h notice served at 07:00 CDT today.
    expect(slots.some((s) => s.toISOString().startsWith('2026-08-10'))).toBe(false)
  })

  it('spans exactly daysAhead calendar days', () => {
    const slots = availableShowingSlots({
      now: NOW,
      timezone: TZ,
      bookedStarts: [],
      window: { daysAhead: 3 },
    })
    const days = new Set(slots.map((s) => s.toISOString().slice(0, 10)))
    // 3 local days from a 07:00 CDT "now": today, tomorrow, day after.
    expect(days.size).toBe(3)
  })
})
