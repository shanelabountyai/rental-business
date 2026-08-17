import { describe, expect, it } from 'vitest'
import { retaliationWarning, validateRetaliationAck } from './retaliation.ts'

// The retaliation-claim guard (RISK-06, R-055). Pure decision logic - the
// database half (apps/web/lib/leases/retaliation-check.ts) fetches the
// window and the most recent complaint; this decides what to do with them.

const DAY = 24 * 60 * 60 * 1000

describe('retaliationWarning', () => {
  it('is silent when the window is not configured', () => {
    expect(
      retaliationWarning({
        actionDate: new Date('2026-08-17'),
        mostRecentComplaint: {
          ticketId: 't1',
          category: 'no heat',
          occurredAt: new Date('2026-08-01'),
        },
        windowDays: null,
      }),
    ).toBeNull()
  })

  it('is silent when there is no complaint on record', () => {
    expect(
      retaliationWarning({
        actionDate: new Date('2026-08-17'),
        mostRecentComplaint: null,
        windowDays: 180,
      }),
    ).toBeNull()
  })

  it('warns when a complaint falls inside the window', () => {
    const warning = retaliationWarning({
      actionDate: new Date('2026-08-17T00:00:00Z'),
      mostRecentComplaint: {
        ticketId: 't1',
        category: 'no heat',
        occurredAt: new Date('2026-07-17T00:00:00Z'),
      },
      windowDays: 180,
    })
    expect(warning).toEqual({
      ticketId: 't1',
      category: 'no heat',
      occurredAt: new Date('2026-07-17T00:00:00Z'),
      daysAgo: 31,
      windowDays: 180,
    })
  })

  it('is silent once the complaint is outside the window', () => {
    const actionDate = new Date('2026-08-17T00:00:00Z')
    const complaint = {
      ticketId: 't1',
      category: 'mold',
      occurredAt: new Date(actionDate.getTime() - 181 * DAY),
    }
    expect(
      retaliationWarning({ actionDate, mostRecentComplaint: complaint, windowDays: 180 }),
    ).toBeNull()
  })

  it('warns on the exact boundary day (inclusive)', () => {
    const actionDate = new Date('2026-08-17T00:00:00Z')
    const complaint = {
      ticketId: 't1',
      category: 'sewage',
      occurredAt: new Date(actionDate.getTime() - 180 * DAY),
    }
    expect(
      retaliationWarning({ actionDate, mostRecentComplaint: complaint, windowDays: 180 }),
    ).not.toBeNull()
  })

  it('is silent for a complaint dated after the action - it cannot be what the action retaliated against', () => {
    const actionDate = new Date('2026-08-01T00:00:00Z')
    const complaint = {
      ticketId: 't1',
      category: 'leak',
      occurredAt: new Date('2026-08-10T00:00:00Z'),
    }
    expect(
      retaliationWarning({ actionDate, mostRecentComplaint: complaint, windowDays: 180 }),
    ).toBeNull()
  })
})

describe('validateRetaliationAck', () => {
  it('requires a reason', () => {
    expect(validateRetaliationAck(null)).toContainEqual(
      expect.objectContaining({ field: 'retaliationReason' }),
    )
    expect(validateRetaliationAck('   ')).toContainEqual(
      expect.objectContaining({ field: 'retaliationReason' }),
    )
  })

  it('accepts a stated reason', () => {
    expect(validateRetaliationAck('Portfolio-wide increase, unrelated to this tenant.')).toEqual(
      [],
    )
  })
})
