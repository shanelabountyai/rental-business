import { describe, expect, it } from 'vitest'
import {
  type AccessCodeInput,
  type ApplianceInput,
  type ShutoffLocationInput,
  type UtilityAccountInput,
  validateAccessCode,
  validateAppliance,
  validateShutoffLocation,
  validateUtilityAccount,
} from './index.ts'

describe('validateAccessCode', () => {
  const base: AccessCodeInput = { unitId: 'unit_1', type: 'LOCKBOX', code: '4821' }

  it('accepts a minimal valid code', () => {
    expect(validateAccessCode(base)).toEqual([])
  })
  it('rejects a missing unit', () => {
    expect(validateAccessCode({ ...base, unitId: '' })).toContainEqual(
      expect.objectContaining({ field: 'unitId' }),
    )
  })
  it('rejects an unknown type', () => {
    expect(validateAccessCode({ ...base, type: 'BOLT_CUTTER' })).toContainEqual(
      expect.objectContaining({ field: 'type' }),
    )
  })
  it('rejects a blank code', () => {
    expect(validateAccessCode({ ...base, code: '  ' })).toContainEqual(
      expect.objectContaining({ field: 'code' }),
    )
  })
})

describe('validateAppliance', () => {
  const base: ApplianceInput = { unitId: 'unit_1', category: 'HVAC' }

  it('accepts a minimal valid appliance', () => {
    expect(validateAppliance(base)).toEqual([])
  })
  it('rejects an unknown category', () => {
    expect(validateAppliance({ ...base, category: 'TOASTER' })).toContainEqual(
      expect.objectContaining({ field: 'category' }),
    )
  })
  it('rejects an unparseable install date', () => {
    expect(validateAppliance({ ...base, installedOn: 'not a date' })).toContainEqual(
      expect.objectContaining({ field: 'installedOn' }),
    )
  })
  it('accepts a valid install date', () => {
    expect(validateAppliance({ ...base, installedOn: '2023-05-01' })).toEqual([])
  })
})

describe('validateUtilityAccount', () => {
  const base: UtilityAccountInput = {
    unitId: 'unit_1',
    type: 'ELECTRIC',
    provider: 'Austin Energy',
    landlordRevertAgreement: false,
  }

  it('accepts a minimal valid account', () => {
    expect(validateUtilityAccount(base)).toEqual([])
  })
  it('rejects an unknown type', () => {
    expect(validateUtilityAccount({ ...base, type: 'CABLE' })).toContainEqual(
      expect.objectContaining({ field: 'type' }),
    )
  })
  it('rejects a blank provider', () => {
    expect(validateUtilityAccount({ ...base, provider: ' ' })).toContainEqual(
      expect.objectContaining({ field: 'provider' }),
    )
  })
})

describe('validateShutoffLocation', () => {
  const base: ShutoffLocationInput = {
    unitId: 'unit_1',
    type: 'WATER_MAIN',
    description: 'Left side of the house, under the hose bib.',
  }

  it('accepts a minimal valid shutoff', () => {
    expect(validateShutoffLocation(base)).toEqual([])
  })
  it('rejects an unknown type', () => {
    expect(validateShutoffLocation({ ...base, type: 'CABLE' })).toContainEqual(
      expect.objectContaining({ field: 'type' }),
    )
  })
  it('rejects a blank description', () => {
    expect(validateShutoffLocation({ ...base, description: '  ' })).toContainEqual(
      expect.objectContaining({ field: 'description' }),
    )
  })
})
