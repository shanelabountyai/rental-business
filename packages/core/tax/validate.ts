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

export interface MortgageAnnualStatementInput {
  mortgageId: string
  taxYear: number | null
  interestCents: number | null
  principalCents?: number | null
  escrowCents?: number | null
  notes?: string | null
}

function badCents(value: number | null | undefined, { required }: { required: boolean }): boolean {
  if (value == null) return required
  return Number.isNaN(value) || !Number.isInteger(value) || value < 0
}

/// A 1098 is always a calendar year, so `taxYear` is a plain integer and the
/// bounds are a typo guard rather than a rule: 1900 and 2999 are both
/// certainly mistakes, and refusing them beats storing a year that silently
/// matches no report.
export function validateMortgageAnnualStatement(
  input: MortgageAnnualStatementInput,
): { field: string; message: string }[] {
  const violations: { field: string; message: string }[] = []
  if (!input.mortgageId.trim()) {
    violations.push({ field: 'mortgageId', message: 'A statement must belong to a mortgage.' })
  }
  if (
    input.taxYear == null ||
    Number.isNaN(input.taxYear) ||
    !Number.isInteger(input.taxYear) ||
    input.taxYear < 1980 ||
    input.taxYear > 2100
  ) {
    violations.push({ field: 'taxYear', message: 'Enter the tax year the 1098 covers.' })
  }
  // Box 1 is the only figure Schedule E needs, so it is the only one required.
  if (badCents(input.interestCents, { required: true })) {
    violations.push({ field: 'interestDollars', message: 'Enter the interest from box 1.' })
  }
  if (badCents(input.principalCents, { required: false })) {
    violations.push({ field: 'principalDollars', message: 'Enter a whole-dollar amount of $0 or more.' })
  }
  if (badCents(input.escrowCents, { required: false })) {
    violations.push({ field: 'escrowDollars', message: 'Enter a whole-dollar amount of $0 or more.' })
  }
  return violations
}
