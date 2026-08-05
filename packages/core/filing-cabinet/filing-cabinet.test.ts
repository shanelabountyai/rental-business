import { describe, expect, it } from 'vitest'
import {
  type HoaInfoInput,
  type InsurancePolicyInput,
  type MortgageInput,
  type WarrantyInput,
  insuranceRenewalDue,
  mortgageArmAdjustmentDue,
  mortgageBalloonMaturityDue,
  validateCostBasis,
  validateHoaInfo,
  validateInsurancePolicy,
  validateMortgage,
  validateWarranty,
} from './index.ts'

describe('validateMortgage', () => {
  const base: MortgageInput = {
    propertyId: 'prop_1',
    lender: 'First National',
    rateType: 'FIXED',
    isBalloon: false,
  }

  it('accepts a minimal valid fixed mortgage', () => {
    expect(validateMortgage(base)).toEqual([])
  })
  it('rejects an unknown rate type', () => {
    expect(validateMortgage({ ...base, rateType: 'INTEREST_ONLY' })).toContainEqual(
      expect.objectContaining({ field: 'rateType' }),
    )
  })
  it('requires an adjustment date for an ARM', () => {
    expect(validateMortgage({ ...base, rateType: 'ARM' })).toContainEqual(
      expect.objectContaining({ field: 'armAdjustmentDate' }),
    )
  })
  it('accepts an ARM with an adjustment date', () => {
    expect(
      validateMortgage({ ...base, rateType: 'ARM', armAdjustmentDate: '2027-01-15' }),
    ).toEqual([])
  })
  it('rejects a negative balance', () => {
    expect(validateMortgage({ ...base, currentBalanceCents: -100 })).toContainEqual(
      expect.objectContaining({ field: 'currentBalanceCents' }),
    )
  })
  it('rejects a non-integer balance', () => {
    expect(validateMortgage({ ...base, currentBalanceCents: 100.5 })).toContainEqual(
      expect.objectContaining({ field: 'currentBalanceCents' }),
    )
  })
  it('rejects an unrealistic interest rate', () => {
    expect(validateMortgage({ ...base, interestRateBps: 6000 })).toContainEqual(
      expect.objectContaining({ field: 'interestRateBps' }),
    )
  })
})

describe('validateInsurancePolicy', () => {
  const base: InsurancePolicyInput = {
    propertyId: 'prop_1',
    carrier: 'State Farm',
    lossOfRents: false,
    renewsOn: '2027-03-01',
  }

  it('accepts a minimal valid policy', () => {
    expect(validateInsurancePolicy(base)).toEqual([])
  })
  it('rejects a missing renewal date', () => {
    expect(validateInsurancePolicy({ ...base, renewsOn: '' })).toContainEqual(
      expect.objectContaining({ field: 'renewsOn' }),
    )
  })
  it('rejects a negative deductible', () => {
    expect(validateInsurancePolicy({ ...base, deductibleCents: -500 })).toContainEqual(
      expect.objectContaining({ field: 'deductibleCents' }),
    )
  })
})

describe('validateHoaInfo', () => {
  const base: HoaInfoInput = { propertyId: 'prop_1', hasRentalCap: false }

  it('accepts a minimal valid record', () => {
    expect(validateHoaInfo(base)).toEqual([])
  })
  it('rejects a missing property', () => {
    expect(validateHoaInfo({ ...base, propertyId: '' })).toContainEqual(
      expect.objectContaining({ field: 'propertyId' }),
    )
  })
})

describe('validateWarranty', () => {
  const base: WarrantyInput = { propertyId: 'prop_1', category: 'ROOF', provider: 'GAF' }

  it('accepts a minimal valid warranty', () => {
    expect(validateWarranty(base)).toEqual([])
  })
  it('rejects an unknown category', () => {
    expect(validateWarranty({ ...base, category: 'POOL' })).toContainEqual(
      expect.objectContaining({ field: 'category' }),
    )
  })
  it('rejects an unparseable expiry date', () => {
    expect(validateWarranty({ ...base, expiresOn: 'soon' })).toContainEqual(
      expect.objectContaining({ field: 'expiresOn' }),
    )
  })
})

describe('validateCostBasis', () => {
  it('accepts null', () => {
    expect(validateCostBasis(null)).toEqual([])
  })
  it('accepts a whole-dollar amount', () => {
    expect(validateCostBasis(25_000_00)).toEqual([])
  })
  it('rejects a negative amount', () => {
    expect(validateCostBasis(-1)).toContainEqual(
      expect.objectContaining({ field: 'costBasisDollars' }),
    )
  })
})

describe('mortgage alerts', () => {
  const asOf = new Date('2027-01-01T00:00:00Z')

  it('flags an ARM adjusting within the window', () => {
    const mortgage = {
      rateType: 'ARM',
      armAdjustmentDate: new Date('2027-02-15T00:00:00Z'),
      isBalloon: false,
      maturityDate: null,
    }
    expect(mortgageArmAdjustmentDue(mortgage, asOf)).toBe(true)
  })
  it('does not flag an ARM adjusting past the window', () => {
    const mortgage = {
      rateType: 'ARM',
      armAdjustmentDate: new Date('2028-01-01T00:00:00Z'),
      isBalloon: false,
      maturityDate: null,
    }
    expect(mortgageArmAdjustmentDue(mortgage, asOf)).toBe(false)
  })
  it('does not flag a fixed-rate mortgage even with a stray adjustment date', () => {
    const mortgage = {
      rateType: 'FIXED',
      armAdjustmentDate: new Date('2027-02-15T00:00:00Z'),
      isBalloon: false,
      maturityDate: null,
    }
    expect(mortgageArmAdjustmentDue(mortgage, asOf)).toBe(false)
  })
  it('does not flag a date already in the past', () => {
    const mortgage = {
      rateType: 'ARM',
      armAdjustmentDate: new Date('2026-12-01T00:00:00Z'),
      isBalloon: false,
      maturityDate: null,
    }
    expect(mortgageArmAdjustmentDue(mortgage, asOf)).toBe(false)
  })
  it('flags a balloon maturing within the window', () => {
    const mortgage = {
      rateType: 'FIXED',
      armAdjustmentDate: null,
      isBalloon: true,
      maturityDate: new Date('2027-06-01T00:00:00Z'),
    }
    expect(mortgageBalloonMaturityDue(mortgage, asOf)).toBe(true)
  })
  it('does not flag a non-balloon mortgage even near maturity', () => {
    const mortgage = {
      rateType: 'FIXED',
      armAdjustmentDate: null,
      isBalloon: false,
      maturityDate: new Date('2027-06-01T00:00:00Z'),
    }
    expect(mortgageBalloonMaturityDue(mortgage, asOf)).toBe(false)
  })
})

describe('insuranceRenewalDue', () => {
  const asOf = new Date('2027-01-01T00:00:00Z')

  it('flags a renewal within 60 days', () => {
    expect(insuranceRenewalDue(new Date('2027-02-15T00:00:00Z'), asOf)).toBe(true)
  })
  it('does not flag a renewal further out', () => {
    expect(insuranceRenewalDue(new Date('2027-06-01T00:00:00Z'), asOf)).toBe(false)
  })
  it('does not flag a renewal date already past', () => {
    expect(insuranceRenewalDue(new Date('2026-12-01T00:00:00Z'), asOf)).toBe(false)
  })
})
