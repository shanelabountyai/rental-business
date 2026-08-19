import { addBusinessDays, businessDate, wallClockToUtc } from './local-time.ts'

// Self-serve showing slot generation (LEASE-08, R-064).
//
// NO PER-PROPERTY BUSINESS-HOURS CONFIG EXISTS ANYWHERE IN THIS CODEBASE -
// grepped for it before writing this. Rather than invent one, the window is
// a fixed constant every property shares.
//
// ponytail: fixed 9am-6pm, half-hour slots, two weeks out - a real operator
// may want per-property hours (an owner who lives on-site vs. a portfolio
// with an agent) or a longer window. Upgrade path is a `window` override
// read from `Property` once that need is real; nothing here assumes a
// single global constant, `availableShowingSlots` already takes one.

export interface ShowingWindowConfig {
  /// Property-local hour showings may start at, inclusive.
  startHour: number
  /// Property-local hour showings may start before, exclusive - the LAST
  /// bookable slot starts `slotMinutes` short of this.
  endHour: number
  slotMinutes: number
  daysAhead: number
  /// Nobody may book a slot starting sooner than this many hours from now,
  /// occupied or vacant - the minimum time to actually get a staff escort
  /// there (R-064: every showing is escorted, no lockbox yet).
  minLeadHours: number
}

export const DEFAULT_SHOWING_WINDOW: ShowingWindowConfig = {
  startHour: 9,
  endHour: 18,
  slotMinutes: 30,
  daysAhead: 14,
  minLeadHours: 2,
}

/**
 * Every open, bookable slot for one unit.
 *
 * `earliestStart`, when given, is `earliestCompliantStart()` from
 * packages/core/entry - the occupied-unit case, where a slot inside the
 * jurisdiction's entry-notice period is not lawfully offerable at all.
 * `bookedStarts` excludes anything another prospect already holds; the fixed
 * grid means an exact-start match is the only possible collision, so no
 * overlap math is needed.
 */
export function availableShowingSlots(input: {
  now: Date
  timezone: string
  bookedStarts: readonly Date[]
  earliestStart?: Date | null
  window?: Partial<ShowingWindowConfig>
}): Date[] {
  const cfg = { ...DEFAULT_SHOWING_WINDOW, ...input.window }
  const booked = new Set(input.bookedStarts.map((d) => d.getTime()))
  const floorMs = Math.max(
    input.now.getTime() + cfg.minLeadHours * 3_600_000,
    input.earliestStart?.getTime() ?? 0,
  )

  const slots: Date[] = []
  let day = businessDate(input.now, input.timezone)
  for (let d = 0; d < cfg.daysAhead; d++) {
    for (let minutes = cfg.startHour * 60; minutes < cfg.endHour * 60; minutes += cfg.slotMinutes) {
      const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
      const mm = String(minutes % 60).padStart(2, '0')
      const start = wallClockToUtc(`${day}T${hh}:${mm}`, input.timezone)
      if (start.getTime() < floorMs) continue
      if (booked.has(start.getTime())) continue
      slots.push(start)
    }
    day = addBusinessDays(day, 1)
  }
  return slots
}
