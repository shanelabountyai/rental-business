import { describe, expect, it } from 'vitest'

import { reportToday } from './report-today.ts'
import type { ResolvedScope } from './types.ts'

function scopeOf(
  properties: Array<{ id: string; timezone: string }>,
  selected?: string[],
): ResolvedScope {
  return {
    selection: { kind: 'all' },
    availableEntities: [],
    availableProperties: properties.map((p) => ({
      id: p.id,
      name: p.id,
      legalEntityId: 'entity',
      timezone: p.timezone,
    })),
    propertyIds: selected ?? properties.map((p) => p.id),
    switchable: false,
  }
}

// 2026-08-30T01:30:00Z is still the 29th in Chicago (20:30) and in New York
// (21:30) - the hour of the evening the UTC stamp used to run a day ahead.
const EVENING = new Date('2026-08-30T01:30:00.000Z')

describe('reportToday', () => {
  it('does not run the range into a UTC tomorrow', () => {
    expect(reportToday(scopeOf([{ id: 'a', timezone: 'America/Chicago' }]), EVENING)).toBe(
      '2026-08-29',
    )
  })

  it('takes the LATEST local day, so no property loses today off an inclusive end', () => {
    // 2026-08-30T04:30:00Z: already the 30th in New York, still the 29th in
    // Los Angeles. The earliest-day rule `complianceToday` uses would cut the
    // eastern property's rows for the 30th out of the report.
    const now = new Date('2026-08-30T04:30:00.000Z')
    const scope = scopeOf([
      { id: 'west', timezone: 'America/Los_Angeles' },
      { id: 'east', timezone: 'America/New_York' },
    ])
    expect(reportToday(scope, now)).toBe('2026-08-30')
  })

  it('reads the clock of the CURRENT selection, not of everything visible', () => {
    const now = new Date('2026-08-30T04:30:00.000Z')
    const scope = scopeOf(
      [
        { id: 'west', timezone: 'America/Los_Angeles' },
        { id: 'east', timezone: 'America/New_York' },
      ],
      ['west'],
    )
    expect(reportToday(scope, now)).toBe('2026-08-29')
  })

  it('falls back to UTC when nothing is in scope', () => {
    expect(reportToday(scopeOf([]), EVENING)).toBe('2026-08-30')
  })
})
