import { describe, expect, it } from 'vitest'
import { type UndepositedPayment, groupForDeposit } from './deposit-slip.ts'

function payment(overrides: Partial<UndepositedPayment> = {}): UndepositedPayment {
  return {
    id: 'pay-1',
    amountCents: 10_000,
    channel: 'OFFLINE_CHECK',
    checkNumber: '101',
    receivedOn: '2026-09-01',
    receivedByStaffId: 'staff-1',
    legalEntityId: 'entity-1',
    ...overrides,
  }
}

describe('groupForDeposit', () => {
  it('groups same-day, same-receiver, same-entity payments into one batch', () => {
    const groups = groupForDeposit([
      payment({ id: 'p1', amountCents: 10_000 }),
      payment({ id: 'p2', amountCents: 5_000, checkNumber: '102' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.paymentIds).toEqual(['p1', 'p2'])
    expect(groups[0]!.totalCents).toBe(15_000)
  })

  it('splits by receiver even on the same day and entity', () => {
    const groups = groupForDeposit([
      payment({ id: 'p1', receivedByStaffId: 'staff-1' }),
      payment({ id: 'p2', receivedByStaffId: 'staff-2' }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('splits by day even for the same receiver', () => {
    const groups = groupForDeposit([
      payment({ id: 'p1', receivedOn: '2026-09-01' }),
      payment({ id: 'p2', receivedOn: '2026-09-02' }),
    ])
    expect(groups).toHaveLength(2)
  })

  // Two properties under one LLC share a bank account and can share a slip;
  // two different LLCs cannot, because that would be money moving between
  // bank accounts that never actually happened.
  it('splits by legal entity even for the same day and receiver', () => {
    const groups = groupForDeposit([
      payment({ id: 'p1', legalEntityId: 'entity-1' }),
      payment({ id: 'p2', legalEntityId: 'entity-2' }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('sorts newest received-on first', () => {
    const groups = groupForDeposit([
      payment({ id: 'p1', receivedOn: '2026-08-01', receivedByStaffId: 'a' }),
      payment({ id: 'p2', receivedOn: '2026-09-01', receivedByStaffId: 'b' }),
    ])
    expect(groups.map((g) => g.receivedOn)).toEqual(['2026-09-01', '2026-08-01'])
  })

  it('returns nothing for an empty list', () => {
    expect(groupForDeposit([])).toEqual([])
  })
})
