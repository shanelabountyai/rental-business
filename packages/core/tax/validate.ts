// Validation for the capital-improvement log (PROP-07, R-078). Hand-rolled,
// matching every other packages/core validate.ts in this repo.

interface Violation {
  field: string
  message: string
}

/// Closed vocabulary in code against a free-form column - the same posture
/// `WARRANTY_CATEGORIES` takes. A component nobody anticipated needs a new
/// entry here, not a migration.
export const CAPITAL_IMPROVEMENT_CATEGORIES = [
  'ROOF',
  'HVAC',
  'WATER_HEATER',
  'PLUMBING',
  'ELECTRICAL',
  'WINDOWS',
  'FLOORING',
  'APPLIANCE',
  'STRUCTURE',
  'EXTERIOR',
  'LANDSCAPE',
  'OTHER',
] as const
export type CapitalImprovementCategoryValue = (typeof CAPITAL_IMPROVEMENT_CATEGORIES)[number]

export interface CapitalImprovementInput {
  propertyId: string
  category: string
  description: string
  costCents: number | null
  inServiceOn?: string | null
  workOrderId?: string | null
  notes?: string | null
}

export function validateCapitalImprovement(input: CapitalImprovementInput): Violation[] {
  const violations: Violation[] = []
  if (!input.propertyId.trim()) {
    violations.push({ field: 'propertyId', message: 'An improvement must belong to a property.' })
  }
  if (!(CAPITAL_IMPROVEMENT_CATEGORIES as readonly string[]).includes(input.category)) {
    violations.push({ field: 'category', message: 'Choose a category.' })
  }
  if (!input.description.trim()) {
    violations.push({
      field: 'description',
      message: 'Describe the work — a preparer reading this in three years needs to know what it was.',
    })
  }
  // REQUIRED, and unlike every other amount in the filing cabinet it may not
  // be zero: an improvement with no cost is nothing to capitalise and nothing
  // to depreciate, so a blank here would put a meaningless row on a
  // depreciation schedule.
  if (
    input.costCents == null ||
    Number.isNaN(input.costCents) ||
    !Number.isInteger(input.costCents) ||
    input.costCents <= 0
  ) {
    violations.push({ field: 'costDollars', message: 'Enter what the improvement cost.' })
  }
  if (input.inServiceOn != null && Number.isNaN(Date.parse(input.inServiceOn))) {
    violations.push({ field: 'inServiceOn', message: 'Enter a valid date.' })
  }
  return violations
}
