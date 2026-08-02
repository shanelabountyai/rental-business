import { describe, expect, it } from 'vitest'
import { addressComparisonKey, validateAddress } from './address.ts'
import { isUsStateCode } from './us-states.ts'
import {
  type PropertyInput,
  validateLegalEntity,
  validateProperty,
} from './validate.ts'

const VALID_ADDRESS = {
  addressLine1: '125 Elm St',
  city: 'Houston',
  state: 'TX',
  postalCode: '77002',
}

function validProperty(overrides: Partial<PropertyInput> = {}): PropertyInput {
  return {
    legalEntityId: 'entity_1',
    name: '125 Elm St',
    propertyType: 'SINGLE_FAMILY',
    timezone: 'America/Chicago',
    ...VALID_ADDRESS,
    ...overrides,
  }
}

describe('US state codes', () => {
  it('accepts real codes and rejects everything else', () => {
    expect(isUsStateCode('TX')).toBe(true)
    expect(isUsStateCode('DC')).toBe(true)
    expect(isUsStateCode('tx')).toBe(false)
    expect(isUsStateCode('Texas')).toBe(false)
    expect(isUsStateCode('XX')).toBe(false)
    expect(isUsStateCode('')).toBe(false)
  })
})

describe('address validation', () => {
  it('accepts a well-formed address', () => {
    expect(validateAddress(VALID_ADDRESS)).toEqual([])
  })

  it('accepts a ZIP+4', () => {
    expect(
      validateAddress({ ...VALID_ADDRESS, postalCode: '77002-1234' }),
    ).toEqual([])
  })

  it.each(['addressLine1', 'city', 'state', 'postalCode'] as const)(
    'requires %s',
    (field) => {
      const violations = validateAddress({ ...VALID_ADDRESS, [field]: '  ' })
      expect(violations.map((v) => v.field)).toContain(field)
    },
  )

  it('rejects a malformed ZIP', () => {
    const violations = validateAddress({ ...VALID_ADDRESS, postalCode: 'abcde' })
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'postalCode', code: 'invalid_zip' }),
    )
  })
})

describe('address comparison key (duplicate detection)', () => {
  it('collides on the realistic duplicate-entry case', () => {
    // The scenario PROP-01's warning exists for: someone re-typing the same
    // address with a different abbreviation.
    const a = addressComparisonKey({
      addressLine1: '125 Elm St',
      postalCode: '77002',
    })
    const b = addressComparisonKey({
      addressLine1: '125 elm street',
      postalCode: '77002-4321',
    })
    expect(a).toBe(b)
  })

  it('folds common suffix and direction words', () => {
    expect(
      addressComparisonKey({
        addressLine1: '400 North Boulevard',
        postalCode: '77002',
      }),
    ).toBe(
      addressComparisonKey({
        addressLine1: '400 N Blvd',
        postalCode: '77002',
      }),
    )
  })

  it('does not collide on a genuinely different street', () => {
    expect(
      addressComparisonKey({ addressLine1: '125 Elm St', postalCode: '77002' }),
    ).not.toBe(
      addressComparisonKey({ addressLine1: '127 Elm St', postalCode: '77002' }),
    )
  })

  it('does not collide on a different ZIP', () => {
    expect(
      addressComparisonKey({ addressLine1: '125 Elm St', postalCode: '77002' }),
    ).not.toBe(
      addressComparisonKey({ addressLine1: '125 Elm St', postalCode: '90210' }),
    )
  })

  // Line 2 (unit/apt) deliberately does not participate - two units at the
  // same street address should still trigger the warning, which is the
  // scenario ("a second record for a property that already has one").
  it('ignores line 2, so two units at one address still collide', () => {
    const key = ({ line2 }: { line2?: string }) =>
      addressComparisonKey({
        addressLine1: '125 Elm St',
        postalCode: '77002',
      })
    expect(key({ line2: 'Unit A' })).toBe(key({ line2: 'Unit B' }))
  })
})

describe('legal entity validation', () => {
  it('accepts a minimal valid entity', () => {
    expect(validateLegalEntity({ name: 'Acme LLC', type: 'LLC' })).toEqual([])
  })

  it('requires a name', () => {
    const violations = validateLegalEntity({ name: '  ', type: 'LLC' })
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'name' }),
    )
  })

  it('rejects an unknown type', () => {
    const violations = validateLegalEntity({ name: 'Acme', type: 'NONPROFIT' })
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'type' }),
    )
  })

  it('accepts a missing formation state', () => {
    expect(
      validateLegalEntity({ name: 'Acme', type: 'PERSONAL', formationState: null }),
    ).toEqual([])
  })

  it('rejects an invalid formation state', () => {
    const violations = validateLegalEntity({
      name: 'Acme',
      type: 'LLC',
      formationState: 'ZZ',
    })
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'formationState' }),
    )
  })
})

describe('property validation', () => {
  it('accepts a minimal valid property', () => {
    expect(validateProperty(validProperty())).toEqual([])
  })

  it('accepts a fully populated property', () => {
    expect(
      validateProperty(
        validProperty({
          bedrooms: 3,
          bathrooms: 2.5,
          yearBuilt: 1998,
          acquiredOn: '2024-01-15',
        }),
      ),
    ).toEqual([])
  })

  it('requires an owning entity', () => {
    const violations = validateProperty(validProperty({ legalEntityId: '' }))
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'legalEntityId' }),
    )
  })

  it('requires a name', () => {
    const violations = validateProperty(validProperty({ name: '  ' }))
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'name' }),
    )
  })

  it('rejects an unknown property type', () => {
    const violations = validateProperty(
      validProperty({ propertyType: 'CASTLE' }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'propertyType' }),
    )
  })

  // The load-bearing checks: D-3 and D-4 both depend on these two fields, and
  // both fail silently at read time rather than loudly - so the write path is
  // where a bad value has to be stopped.
  it('rejects a state outside the US code list', () => {
    const violations = validateProperty(validProperty({ state: 'Texas' }))
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'state' }),
    )
  })

  it('rejects an empty timezone', () => {
    const violations = validateProperty(validProperty({ timezone: '' }))
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'timezone' }),
    )
  })

  it('rejects a UTC-offset-shaped timezone, which is not IANA and breaks across DST', () => {
    const violations = validateProperty(validProperty({ timezone: 'UTC-6' }))
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'timezone' }),
    )
  })

  it('rejects a plausible-looking but invented timezone', () => {
    const violations = validateProperty(
      validProperty({ timezone: 'America/Nowhere' }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'timezone' }),
    )
  })

  it('accepts every real IANA zone the runtime knows about', () => {
    for (const zone of [
      'America/Chicago',
      'America/Denver',
      'America/Phoenix',
      'Pacific/Honolulu',
      'America/New_York',
    ]) {
      expect(validateProperty(validProperty({ timezone: zone }))).toEqual([])
    }
  })

  it.each([-1, 21])('rejects %s bedrooms as unrealistic', (bedrooms) => {
    const violations = validateProperty(validProperty({ bedrooms }))
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'bedrooms' }),
    )
  })

  // NaN < 0 and NaN > 20 are both false, so a naive range check silently lets
  // garbage through. The browser cannot submit non-numeric text from a number
  // input, but a server action is callable directly.
  it('rejects NaN rather than silently accepting it', () => {
    const violations = validateProperty(validProperty({ bedrooms: Number.NaN }))
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'bedrooms' }),
    )
  })

  it.each([1699, new Date().getUTCFullYear() + 2])(
    'rejects a year built of %s',
    (yearBuilt) => {
      const violations = validateProperty(validProperty({ yearBuilt }))
      expect(violations).toContainEqual(
        expect.objectContaining({ field: 'yearBuilt' }),
      )
    },
  )

  it('rejects an acquisition date in the future', () => {
    const nextYear = new Date()
    nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1)
    const violations = validateProperty(
      validProperty({ acquiredOn: nextYear.toISOString().slice(0, 10) }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'acquiredOn' }),
    )
  })

  it('rejects a malformed acquisition date', () => {
    const violations = validateProperty(
      validProperty({ acquiredOn: 'not-a-date' }),
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ field: 'acquiredOn' }),
    )
  })

  it('accumulates every violation rather than stopping at the first', () => {
    const violations = validateProperty({
      legalEntityId: '',
      name: '',
      propertyType: 'CASTLE',
      timezone: '',
      addressLine1: '',
      city: '',
      state: 'ZZ',
      postalCode: '',
    })
    const fields = violations.map((v) => v.field)
    expect(fields).toEqual(
      expect.arrayContaining([
        'addressLine1',
        'city',
        'postalCode',
        'legalEntityId',
        'name',
        'state',
        'propertyType',
        'timezone',
      ]),
    )
  })
})
