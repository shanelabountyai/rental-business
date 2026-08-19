import { describe, expect, it } from 'vitest'
import { CHECK_HOLD_DAYS, fundsCleared } from './clearing.ts'

describe('fundsCleared', () => {
  const receivedAt = new Date('2026-08-01T12:00:00Z')

  it('refuses anything not SETTLED, regardless of channel', () => {
    expect(fundsCleared({ channel: 'MONEY_ORDER', status: 'PENDING', receivedAt }, receivedAt)).toBe(
      false,
    )
  })

  it('trusts a settled certified channel immediately', () => {
    for (const channel of ['ACH', 'CARD', 'RETAIL_CASH', 'MONEY_ORDER', 'OFFLINE_CASH', 'HAP_ACH']) {
      expect(fundsCleared({ channel, status: 'SETTLED', receivedAt }, receivedAt)).toBe(true)
    }
  })

  it('refuses a settled personal check before its hold elapses', () => {
    const dayBefore = new Date(receivedAt.getTime() + (CHECK_HOLD_DAYS - 1) * 24 * 3_600_000)
    expect(fundsCleared({ channel: 'OFFLINE_CHECK', status: 'SETTLED', receivedAt }, dayBefore)).toBe(
      false,
    )
  })

  it('trusts a settled personal check once the hold elapses', () => {
    const holdEnds = new Date(receivedAt.getTime() + CHECK_HOLD_DAYS * 24 * 3_600_000)
    expect(fundsCleared({ channel: 'OFFLINE_CHECK', status: 'SETTLED', receivedAt }, holdEnds)).toBe(
      true,
    )
  })
})
