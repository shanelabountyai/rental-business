import { describe, expect, it } from 'vitest'
import { debitDayDecision, debitDayRefusalMessage } from './debit-day.ts'

// Texas: rent due on the 1st, three days' grace (the shipped seed).
const texas = { rentDueDay: 1, graceDays: 3 }

describe('debitDayDecision', () => {
  it('allows the due day itself', () => {
    expect(debitDayDecision({ debitDay: 1, ...texas }).allowed).toBe(true)
  })

  it('allows a day inside the grace period - the whole point of the feature', () => {
    // Rent due on the 1st, paid on the 3rd. Autopay firing on the 1st against
    // an empty account is a failed debit, an NSF fee and a phone call.
    expect(debitDayDecision({ debitDay: 3, ...texas }).allowed).toBe(true)
    expect(debitDayDecision({ debitDay: 4, ...texas }).allowed).toBe(true)
  })

  it('REFUSES a day past grace, because the tenant would be charged for it', () => {
    // The nightly late-fee assessment reads the same jurisdiction config and
    // does not care that money was on its way. Offering a choice that
    // silently charges for itself is worse than offering none.
    const decision = debitDayDecision({ debitDay: 5, ...texas })
    expect(decision.allowed).toBe(false)
    expect(decision.refusal).toBe('after_grace')
    expect(decision.latestSafeDay).toBe(4)
  })

  it('REFUSES a day before rent is due', () => {
    // Not unlawful, just money taken before it is owed. Refused for the
    // tenant's benefit rather than ours.
    const decision = debitDayDecision({ debitDay: 10, rentDueDay: 15, graceDays: 3 })
    expect(decision.refusal).toBe('before_due')
  })

  it('caps the safe day at 28, like rentDueDay itself', () => {
    // A debit on the 30th has no equivalent in February, and every
    // downstream billing anchor would have to invent one.
    expect(debitDayDecision({ debitDay: 28, rentDueDay: 27, graceDays: 5 }).latestSafeDay).toBe(28)
    expect(debitDayDecision({ debitDay: 29, rentDueDay: 27, graceDays: 5 }).refusal).toBe(
      'out_of_range',
    )
  })

  it('refuses anything that is not a whole day in range', () => {
    for (const debitDay of [0, -1, 29, 31, 1.5, Number.NaN]) {
      expect(debitDayDecision({ debitDay, ...texas }).refusal).toBe('out_of_range')
    }
  })

  it('moves when the statute does, not when somebody edits a constant', () => {
    // D-4: grace comes from the versioned jurisdiction rule.
    expect(debitDayDecision({ debitDay: 8, rentDueDay: 1, graceDays: 7 }).allowed).toBe(true)
    expect(debitDayDecision({ debitDay: 8, rentDueDay: 1, graceDays: 3 }).allowed).toBe(false)
  })
})

describe('debitDayRefusalMessage', () => {
  it('tells a tenant what would happen to them, not which rule fired', () => {
    const message = debitDayRefusalMessage('after_grace', 4)
    expect(message).toMatch(/late fee/i)
    expect(message).toContain('4')
    expect(message).not.toMatch(/grace|jurisdiction|rule/i)
  })
})
