// Validation for unit operational data (PROP-03, R-014): access codes,
// appliances, utility accounts, shutoff locations. Hand-rolled, matching
// every other packages/core validate.ts in this repo.

interface Violation {
  field: string
  message: string
}

export const ACCESS_CODE_TYPES = [
  'LOCKBOX',
  'SMART_LOCK',
  'GATE',
  'MAILBOX',
  'OTHER',
] as const
export type AccessCodeTypeValue = (typeof ACCESS_CODE_TYPES)[number]

export interface AccessCodeInput {
  unitId: string
  type: string
  label?: string | null
  code: string
}

export function validateAccessCode(input: AccessCodeInput): Violation[] {
  const violations: Violation[] = []
  if (!input.unitId.trim()) {
    violations.push({ field: 'unitId', message: 'An access code must belong to a unit.' })
  }
  if (!(ACCESS_CODE_TYPES as readonly string[]).includes(input.type)) {
    violations.push({ field: 'type', message: 'Choose a type.' })
  }
  if (!input.code.trim()) {
    violations.push({ field: 'code', message: 'Enter the code.' })
  } else if (input.code.length > 100) {
    violations.push({ field: 'code', message: 'That code is unrealistically long.' })
  }
  return violations
}

export const APPLIANCE_CATEGORIES = [
  'REFRIGERATOR',
  'RANGE',
  'DISHWASHER',
  'WASHER',
  'DRYER',
  'WATER_HEATER',
  'HVAC',
  'MICROWAVE',
  'OTHER',
] as const
export type ApplianceCategoryValue = (typeof APPLIANCE_CATEGORIES)[number]

export interface ApplianceInput {
  unitId: string
  category: string
  make?: string | null
  model?: string | null
  serialNumber?: string | null
  installedOn?: string | null
  filterSize?: string | null
  notes?: string | null
}

export function validateAppliance(input: ApplianceInput): Violation[] {
  const violations: Violation[] = []
  if (!input.unitId.trim()) {
    violations.push({ field: 'unitId', message: 'An appliance must belong to a unit.' })
  }
  if (!(APPLIANCE_CATEGORIES as readonly string[]).includes(input.category)) {
    violations.push({ field: 'category', message: 'Choose a category.' })
  }
  if (input.installedOn != null && Number.isNaN(Date.parse(input.installedOn))) {
    violations.push({ field: 'installedOn', message: 'Enter a valid install date.' })
  }
  return violations
}

export const UTILITY_TYPES = [
  'ELECTRIC',
  'GAS',
  'WATER',
  'SEWER',
  'TRASH',
  'OTHER',
] as const
export type UtilityTypeValue = (typeof UTILITY_TYPES)[number]

export interface UtilityAccountInput {
  unitId: string
  type: string
  provider: string
  accountNumber?: string | null
  nameOnAccountDuringTenancy?: string | null
  nameOnAccountVacancy?: string | null
  landlordRevertAgreement: boolean
  notes?: string | null
}

export function validateUtilityAccount(input: UtilityAccountInput): Violation[] {
  const violations: Violation[] = []
  if (!input.unitId.trim()) {
    violations.push({ field: 'unitId', message: 'A utility account must belong to a unit.' })
  }
  if (!(UTILITY_TYPES as readonly string[]).includes(input.type)) {
    violations.push({ field: 'type', message: 'Choose a utility type.' })
  }
  if (!input.provider.trim()) {
    violations.push({ field: 'provider', message: 'Name the provider.' })
  }
  return violations
}

export const SHUTOFF_TYPES = ['WATER_MAIN', 'BREAKER_PANEL', 'GAS', 'OTHER'] as const
export type ShutoffTypeValue = (typeof SHUTOFF_TYPES)[number]

export interface ShutoffLocationInput {
  unitId: string
  type: string
  description: string
}

export function validateShutoffLocation(input: ShutoffLocationInput): Violation[] {
  const violations: Violation[] = []
  if (!input.unitId.trim()) {
    violations.push({ field: 'unitId', message: 'A shutoff location must belong to a unit.' })
  }
  if (!(SHUTOFF_TYPES as readonly string[]).includes(input.type)) {
    violations.push({ field: 'type', message: 'Choose a type.' })
  }
  if (!input.description.trim()) {
    violations.push({
      field: 'description',
      message: 'Describe where it is - a tenant in a hurry has to find this from words alone.',
    })
  }
  return violations
}
