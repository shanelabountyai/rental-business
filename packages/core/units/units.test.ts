import { describe, expect, it } from 'vitest'
import { type UnitInput, validateUnit } from './validate.ts'

function validUnit(overrides: Partial<UnitInput> = {}): UnitInput {
  return {
    propertyId: 'prop_1',
    name: 'Main house',
    status: 'VACANT',
    ...overrides,
  }
}

describe('unit validation', () => {
  it('accepts a minimal valid unit', () => {
    expect(validateUnit(validUnit())).toEqual([])
  })

  it('accepts a fully populated unit', () => {
    expect(
      validateUnit(
        validUnit({
          marketRentCents: 185_000,
          bedrooms: 3,
          bathrooms: 2.5,
          squareFeet: 1400,
          notes: 'Corner unit',
        }),
      ),
    ).toEqual([])
  })

  it('requires a property', () => {
    expect(validateUnit(validUnit({ propertyId: '' }))).toContainEqual(
      expect.objectContaining({ field: 'propertyId' }),
    )
  })

  it('requires a name', () => {
    expect(validateUnit(validUnit({ name: '  ' }))).toContainEqual(
      expect.objectContaining({ field: 'name' }),
    )
  })

  it('rejects an unknown status', () => {
    expect(validateUnit(validUnit({ status: 'DEMOLISHED' }))).toContainEqual(
      expect.objectContaining({ field: 'status' }),
    )
  })

  it.each(['OCCUPIED', 'VACANT', 'MAKE_READY', 'DOWN'])(
    'accepts the real status %s',
    (status) => {
      expect(validateUnit(validUnit({ status }))).toEqual([])
    },
  )

  it('rejects a negative market rent', () => {
    expect(
      validateUnit(validUnit({ marketRentCents: -100 })),
    ).toContainEqual(expect.objectContaining({ field: 'marketRentCents' }))
  })

  it('rejects a fractional market rent (money is integer cents)', () => {
    expect(
      validateUnit(validUnit({ marketRentCents: 1850.5 })),
    ).toContainEqual(expect.objectContaining({ field: 'marketRentCents' }))
  })

  it('accepts a zero market rent', () => {
    expect(validateUnit(validUnit({ marketRentCents: 0 }))).toEqual([])
  })

  it.each([-1, 21])('rejects %s bedrooms as unrealistic', (bedrooms) => {
    expect(validateUnit(validUnit({ bedrooms }))).toContainEqual(
      expect.objectContaining({ field: 'bedrooms' }),
    )
  })

  it('rejects an unrealistic square footage', () => {
    expect(
      validateUnit(validUnit({ squareFeet: 50_000 })),
    ).toContainEqual(expect.objectContaining({ field: 'squareFeet' }))
  })

  // NaN comparisons are always false, so a naive range check silently lets
  // garbage through unless checked for directly (see packages/core/property's
  // identical test and reasoning).
  it.each(['marketRentCents', 'bedrooms', 'bathrooms', 'squareFeet'] as const)(
    'rejects NaN in %s rather than silently accepting it',
    (field) => {
      expect(
        validateUnit(validUnit({ [field]: Number.NaN })),
      ).toContainEqual(expect.objectContaining({ field }))
    },
  )

  it('accumulates every violation rather than stopping at the first', () => {
    const violations = validateUnit({
      propertyId: '',
      name: '',
      status: 'DEMOLISHED',
      marketRentCents: -1,
    })
    expect(violations.map((v) => v.field)).toEqual(
      expect.arrayContaining(['propertyId', 'name', 'status', 'marketRentCents']),
    )
  })
})
