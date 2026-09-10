import { describe, expect, it } from 'vitest'
import {
  type PropertyExpenseInput,
  expenseOccurrences,
  validatePropertyExpense,
} from './property-expense.ts'

function input(overrides: Partial<PropertyExpenseInput> = {}): PropertyExpenseInput {
  return {
    legalEntityId: 'ent_1',
    propertyId: 'prop_1',
    category: 'TAXES',
    amountCents: 480_000,
    paidOn: '2026-01-30',
    description: '2025 county tax',
    ...overrides,
  }
}

const fields = (overrides: Partial<PropertyExpenseInput>) =>
  validatePropertyExpense(input(overrides), '2026-09-10').map((v) => v.field)

describe('validatePropertyExpense', () => {
  it('accepts a paid tax bill, and an entity-wide one', () => {
    expect(fields({})).toEqual([])
    expect(fields({ propertyId: null })).toEqual([])
  })

  it('refuses a property left unchosen', () => {
    expect(fields({ propertyId: '' })).toEqual(['propertyId'])
  })

  it('refuses a category another record already owns', () => {
    // A repair here would never be excluded from its work order's own
    // deduction: the same dollars, claimed twice.
    expect(fields({ category: 'REPAIRS' })).toEqual(['category'])
    expect(fields({ category: 'UTILITIES' })).toEqual(['category'])
    expect(fields({ category: 'MORTGAGE_INTEREST' })).toEqual(['category'])
  })

  it('refuses a payment that has not happened yet', () => {
    expect(fields({ paidOn: '2026-09-11' })).toEqual(['paidOn'])
    expect(fields({ paidOn: '2026-09-10' })).toEqual([])
  })

  it('refuses a date friendlyBusinessDate would throw on', () => {
    expect(fields({ paidOn: '9/1/2026' })).toEqual(['paidOn'])
    expect(fields({ paidOn: '' })).toEqual(['paidOn'])
  })

  it('refuses a zero, fractional or missing amount, and a blank description', () => {
    expect(fields({ amountCents: 0 })).toEqual(['amountDollars'])
    expect(fields({ amountCents: 10.5 })).toEqual(['amountDollars'])
    expect(fields({ amountCents: null })).toEqual(['amountDollars'])
    expect(fields({ description: '  ' })).toEqual(['description'])
  })
})

describe('expenseOccurrences', () => {
  const monthly = { paidOn: '2026-01-31', recursMonthly: true, recurrenceEndsOn: null }

  it('a one-off is its own date', () => {
    expect(
      expenseOccurrences({ paidOn: '2026-01-30', recursMonthly: false, recurrenceEndsOn: null }, '2026-01-01'),
    ).toEqual(['2026-01-30'])
  })

  it('repeats on the first payment’s day, clamped to short months and not drifting', () => {
    expect(expenseOccurrences(monthly, '2026-04-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
  })

  it('never reaches a month that has not arrived', () => {
    expect(expenseOccurrences(monthly, '2026-03-30')).toEqual(['2026-01-31', '2026-02-28'])
  })

  it('stops at its end date', () => {
    expect(
      expenseOccurrences({ ...monthly, recurrenceEndsOn: '2026-03-31' }, '2026-12-31'),
    ).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
  })

  it('crosses a year boundary', () => {
    expect(
      expenseOccurrences({ paidOn: '2025-11-15', recursMonthly: true, recurrenceEndsOn: null }, '2026-01-20'),
    ).toEqual(['2025-11-15', '2025-12-15', '2026-01-15'])
  })
})
