import { describe, expect, it } from 'vitest'
import { matchesSegment, parseSegment, type TenancyFacts } from './segments.ts'

// The segment predicate (R-258), pure. It decides both the count in the
// picker and who is sent to, so a wrong answer here is a message to the
// wrong people. The database half (scope, ledger rows, open repairs) is
// covered by e2e/announcements.spec.ts; the loader is apps/web/lib/comms/announcements.ts.

const base: TenancyFacts = {
  leaseId: 'l1',
  legalEntityId: 'e1',
  propertyId: 'p1',
  unitId: 'u1',
  metro: 'Houston',
  tags: ['downtown'],
  status: 'ACTIVE',
  today: '2026-10-20',
  startsOn: '2026-01-01',
  endsOn: null,
  balanceCents: 0,
  openMaintenance: false,
}

const matches = (posted: string, facts: Partial<TenancyFacts> = {}) =>
  matchesSegment({ ...base, ...facts }, parseSegment(posted)!)

describe('parseSegment refuses rather than widening', () => {
  it.each([
    'PROPERTY:',
    'UNIT:',
    'ENTITY:',
    'STATUS:ENDED',
    'STATUS:DRAFT',
    'MOVE_IN:',
    'MOVE_IN:365',
    'MOVE_OUT:abc',
    'NOPE',
    '',
  ])('%s is refused', (posted) => {
    expect(parseSegment(posted)).toBeNull()
  })

  it('keeps everything after the first colon of a free-text value', () => {
    expect(parseSegment('TAG:a:b')).toEqual({ type: 'TAG', value: 'a:b' })
  })
})

describe('matchesSegment', () => {
  it('balance due means owing, not a credit or zero', () => {
    expect(matches('BALANCE_DUE', { balanceCents: 1 })).toBe(true)
    expect(matches('BALANCE_DUE', { balanceCents: 0 })).toBe(false)
    expect(matches('BALANCE_DUE', { balanceCents: -5000 })).toBe(false)
  })

  it('move-in counts either side of today, inclusive', () => {
    expect(matches('MOVE_IN:7', { startsOn: '2026-10-13' })).toBe(true)
    expect(matches('MOVE_IN:7', { startsOn: '2026-10-27' })).toBe(true)
    expect(matches('MOVE_IN:7', { startsOn: '2026-10-12' })).toBe(false)
    expect(matches('MOVE_IN:7', { startsOn: '2026-10-28' })).toBe(false)
  })

  it('move-out looks forward only, and an MTM with no notice never matches', () => {
    expect(matches('MOVE_OUT:30', { endsOn: '2026-10-20' })).toBe(true)
    expect(matches('MOVE_OUT:30', { endsOn: '2026-11-19' })).toBe(true)
    expect(matches('MOVE_OUT:30', { endsOn: '2026-11-20' })).toBe(false)
    expect(matches('MOVE_OUT:30', { endsOn: '2026-10-19' })).toBe(false)
    expect(matches('MOVE_OUT:60', { endsOn: null })).toBe(false)
  })

  it('identity filters compare the right field', () => {
    expect(matches('ENTITY:e1')).toBe(true)
    expect(matches('ENTITY:e2')).toBe(false)
    expect(matches('UNIT:u1')).toBe(true)
    expect(matches('UNIT:p1')).toBe(false)
    expect(matches('STATUS:MONTH_TO_MONTH')).toBe(false)
    expect(matches('STATUS:MONTH_TO_MONTH', { status: 'MONTH_TO_MONTH' })).toBe(true)
    expect(matches('OPEN_MAINTENANCE')).toBe(false)
    expect(matches('OPEN_MAINTENANCE', { openMaintenance: true })).toBe(true)
  })
})
