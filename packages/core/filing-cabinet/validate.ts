// Validation for the property filing cabinet (PROP-06, R-015): mortgage,
// insurance, HOA, warranty records. Hand-rolled, matching every other
// packages/core validate.ts in this repo.

interface Violation {
  field: string
  message: string
}

export const MORTGAGE_RATE_TYPES = ['FIXED', 'ARM'] as const
export type MortgageRateTypeValue = (typeof MORTGAGE_RATE_TYPES)[number]

export interface MortgageInput {
  propertyId: string
  lender: string
  originalAmountCents?: number | null
  currentBalanceCents?: number | null
  rateType: string
  interestRateBps?: number | null
  armAdjustmentDate?: string | null
  maturityDate?: string | null
  isBalloon: boolean
  notes?: string | null
}

/// NaN comparisons are always false - checked explicitly so a malformed
/// direct call cannot slip a garbage number past a range check that looks
/// correct (see packages/core/property/validate.ts for the same guard).
function invalidCents(value: number | null | undefined): boolean {
  return value != null && (Number.isNaN(value) || !Number.isInteger(value) || value < 0)
}

export function validateMortgage(input: MortgageInput): Violation[] {
  const violations: Violation[] = []
  if (!input.propertyId.trim()) {
    violations.push({ field: 'propertyId', message: 'A mortgage must belong to a property.' })
  }
  if (!input.lender.trim()) {
    violations.push({ field: 'lender', message: 'Name the lender.' })
  }
  if (!(MORTGAGE_RATE_TYPES as readonly string[]).includes(input.rateType)) {
    violations.push({ field: 'rateType', message: 'Choose a rate type.' })
  }
  if (input.rateType === 'ARM' && !input.armAdjustmentDate) {
    violations.push({
      field: 'armAdjustmentDate',
      message: 'Enter the next adjustment date for an ARM.',
    })
  }
  if (input.armAdjustmentDate != null && Number.isNaN(Date.parse(input.armAdjustmentDate))) {
    violations.push({ field: 'armAdjustmentDate', message: 'Enter a valid date.' })
  }
  if (input.maturityDate != null && Number.isNaN(Date.parse(input.maturityDate))) {
    violations.push({ field: 'maturityDate', message: 'Enter a valid date.' })
  }
  if (invalidCents(input.originalAmountCents)) {
    violations.push({ field: 'originalAmountCents', message: 'Enter a whole-dollar amount of $0 or more.' })
  }
  if (invalidCents(input.currentBalanceCents)) {
    violations.push({ field: 'currentBalanceCents', message: 'Enter a whole-dollar amount of $0 or more.' })
  }
  if (
    input.interestRateBps != null &&
    (Number.isNaN(input.interestRateBps) ||
      !Number.isInteger(input.interestRateBps) ||
      input.interestRateBps < 0 ||
      input.interestRateBps > 5000)
  ) {
    violations.push({ field: 'interestRateBps', message: 'Enter a realistic interest rate.' })
  }
  return violations
}

export interface InsurancePolicyInput {
  propertyId: string
  carrier: string
  policyNumber?: string | null
  limitsCents?: number | null
  deductibleCents?: number | null
  lossOfRents: boolean
  renewsOn: string
  notes?: string | null
}

export function validateInsurancePolicy(input: InsurancePolicyInput): Violation[] {
  const violations: Violation[] = []
  if (!input.propertyId.trim()) {
    violations.push({ field: 'propertyId', message: 'A policy must belong to a property.' })
  }
  if (!input.carrier.trim()) {
    violations.push({ field: 'carrier', message: 'Name the carrier.' })
  }
  if (!input.renewsOn.trim() || Number.isNaN(Date.parse(input.renewsOn))) {
    violations.push({ field: 'renewsOn', message: 'Enter the renewal date.' })
  }
  if (invalidCents(input.limitsCents)) {
    violations.push({ field: 'limitsCents', message: 'Enter a whole-dollar amount of $0 or more.' })
  }
  if (invalidCents(input.deductibleCents)) {
    violations.push({ field: 'deductibleCents', message: 'Enter a whole-dollar amount of $0 or more.' })
  }
  return violations
}

export interface HoaInfoInput {
  propertyId: string
  name?: string | null
  contactInfo?: string | null
  hasRentalCap: boolean
  rentalCapPolicy?: string | null
  notes?: string | null
}

export function validateHoaInfo(input: HoaInfoInput): Violation[] {
  const violations: Violation[] = []
  if (!input.propertyId.trim()) {
    violations.push({ field: 'propertyId', message: 'HOA info must belong to a property.' })
  }
  return violations
}

export const WARRANTY_CATEGORIES = [
  'ROOF',
  'HVAC',
  'WATER_HEATER',
  'APPLIANCE',
  'HOME_WARRANTY',
  'OTHER',
] as const
export type WarrantyCategoryValue = (typeof WARRANTY_CATEGORIES)[number]

export interface WarrantyInput {
  propertyId: string
  category: string
  provider: string
  coverageSummary?: string | null
  expiresOn?: string | null
  notes?: string | null
}

export function validateWarranty(input: WarrantyInput): Violation[] {
  const violations: Violation[] = []
  if (!input.propertyId.trim()) {
    violations.push({ field: 'propertyId', message: 'A warranty must belong to a property.' })
  }
  if (!(WARRANTY_CATEGORIES as readonly string[]).includes(input.category)) {
    violations.push({ field: 'category', message: 'Choose a category.' })
  }
  if (!input.provider.trim()) {
    violations.push({ field: 'provider', message: 'Name the provider.' })
  }
  if (input.expiresOn != null && Number.isNaN(Date.parse(input.expiresOn))) {
    violations.push({ field: 'expiresOn', message: 'Enter a valid date.' })
  }
  return violations
}

/// A single fact on Property itself (see the schema's own comment on
/// costBasisCents), not one of the four filing-cabinet models above - but
/// its number-of-cents shape is identical, so it reuses the same guard.
export function validateCostBasis(costBasisCents: number | null | undefined): Violation[] {
  if (invalidCents(costBasisCents)) {
    return [{ field: 'costBasisDollars', message: 'Enter a whole-dollar amount of $0 or more.' }]
  }
  return []
}
