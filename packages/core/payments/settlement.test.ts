import { describe, expect, it } from 'vitest'
import { type SettlementPayment, summariseSettlements } from './settlement.ts'

const WINDOW = { from: '2026-03-01' as const, to: '2026-03-31' as const }

function payment(over: Partial<SettlementPayment> & Pick<SettlementPayment, 'id'>): SettlementPayment {
  return {
    legalEntityId: 'entity-a',
    propertyId: 'prop-1',
    amountCents: 150_000,
    settledOn: '2026-03-10',
    reversedOn: null,
    ...over,
  }
}

describe('summariseSettlements', () => {
  it('splits the shared account by the entity whose houses earned it', () => {
    const summary = summariseSettlements(
      [
        payment({ id: 'a1', legalEntityId: 'entity-a', propertyId: 'prop-1', amountCents: 150_000 }),
        payment({ id: 'a2', legalEntityId: 'entity-a', propertyId: 'prop-2', amountCents: 120_000 }),
        payment({ id: 'b1', legalEntityId: 'entity-b', propertyId: 'prop-3', amountCents: 200_000 }),
      ],
      WINDOW,
    )

    // Largest net first: A's two houses out-earn B's one.
    expect(summary.entities.map((row) => row.legalEntityId)).toEqual(['entity-a', 'entity-b'])
    expect(summary.entities[0]!.netCents).toBe(270_000)
    expect(summary.entities[1]!.netCents).toBe(200_000)
    // The bank line is the sum of the shares, which is what makes the
    // transfers add back up to the one account.
    expect(summary.netCents).toBe(470_000)
    expect(
      summary.entities.reduce((total, row) => total + row.netCents, 0),
    ).toBe(summary.netCents)
  })

  it('subtracts a reversal from the window it happened in, not the one that earned it', () => {
    const marchThenApril = payment({
      id: 'returned',
      amountCents: 150_000,
      settledOn: '2026-03-10',
      reversedOn: '2026-04-02',
    })

    // March keeps the money: it really was in March's payouts.
    const march = summariseSettlements([marchThenApril], WINDOW)
    expect(march.entities[0]!.settledCents).toBe(150_000)
    expect(march.entities[0]!.reversedCents).toBe(0)
    expect(march.netCents).toBe(150_000)

    // April is short by exactly that, with nothing settled in it.
    const april = summariseSettlements([marchThenApril], { from: '2026-04-01', to: '2026-04-30' })
    expect(april.entities[0]!.settledCents).toBe(0)
    expect(april.entities[0]!.reversedCents).toBe(150_000)
    expect(april.netCents).toBe(-150_000)
  })

  it('shows both halves when a payment settles and returns inside one window', () => {
    const summary = summariseSettlements(
      [payment({ id: 'bounced', settledOn: '2026-03-03', reversedOn: '2026-03-20' })],
      WINDOW,
    )
    // Netting to zero is right; reporting nothing at all is not. An owner
    // reconciling a bank statement sees both movements on it.
    expect(summary.netCents).toBe(0)
    expect(summary.settledCents).toBe(150_000)
    expect(summary.reversedCents).toBe(150_000)
  })

  it('leaves an entity out entirely when neither of its dates falls in the window', () => {
    const summary = summariseSettlements(
      [
        payment({ id: 'january', legalEntityId: 'entity-quiet', settledOn: '2026-01-05' }),
        payment({ id: 'march', legalEntityId: 'entity-a' }),
      ],
      WINDOW,
    )
    // A zero row would read as "this LLC collected nothing", which is a
    // claim about the entity rather than about the window.
    expect(summary.entities.map((row) => row.legalEntityId)).toEqual(['entity-a'])
  })

  it('includes both ends of the window', () => {
    const summary = summariseSettlements(
      [
        payment({ id: 'first', settledOn: '2026-03-01', amountCents: 1_000 }),
        payment({ id: 'last', settledOn: '2026-03-31', amountCents: 2_000 }),
        payment({ id: 'eve', settledOn: '2026-02-28', amountCents: 4_000 }),
        payment({ id: 'after', settledOn: '2026-04-01', amountCents: 8_000 }),
      ],
      WINDOW,
    )
    expect(summary.netCents).toBe(3_000)
  })

  it('breaks an entity down by house, biggest share first', () => {
    const summary = summariseSettlements(
      [
        payment({ id: 'small', propertyId: 'prop-small', amountCents: 90_000 }),
        payment({ id: 'big', propertyId: 'prop-big', amountCents: 210_000 }),
        payment({ id: 'big-returned', propertyId: 'prop-big', amountCents: 60_000, settledOn: '2026-03-04', reversedOn: '2026-03-09' }),
      ],
      WINDOW,
    )
    const [entity] = summary.entities
    expect(entity!.properties.map((row) => row.propertyId)).toEqual(['prop-big', 'prop-small'])
    expect(entity!.properties[0]!.netCents).toBe(210_000)
    expect(entity!.properties[0]!.reversedCents).toBe(60_000)
    // The houses have to add back up to the entity, or the transfer figure
    // and the breakdown explaining it disagree.
    expect(entity!.properties.reduce((total, row) => total + row.netCents, 0)).toBe(entity!.netCents)
  })
})
