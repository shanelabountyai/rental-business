// Unit validation (PROP-02). Hand-rolled, matching packages/core/property's
// style rather than a schema library.
//
// No restricted status-transition matrix: PROP-02 does not ask for one, and
// inventing rules like "OCCUPIED cannot go straight to DOWN" would be wrong
// anyway - a pipe can burst in an occupied unit. Status is free-form for
// staff; the one AUTOMATED transition (lease ends without a renewal in
// place, to MAKE_READY) lives in apps/web/lib/units/auto-make-ready.ts.

export const UNIT_STATUSES = ['OCCUPIED', 'VACANT', 'MAKE_READY', 'DOWN'] as const
export type UnitStatusValue = (typeof UNIT_STATUSES)[number]

// Not exported: identical in shape to packages/core/property's own Violation,
// and re-exporting a second same-named type from the core barrel is a real
// collision (`export *` from both modules). Nothing imports either by name -
// every caller uses the inferred array return type - so there is nothing to
// share and nothing lost by keeping this local.
interface Violation {
  field: string
  message: string
}

export interface UnitInput {
  propertyId: string
  name: string
  status: string
  marketRentCents?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  squareFeet?: number | null
  notes?: string | null
}

export function validateUnit(input: UnitInput): Violation[] {
  const violations: Violation[] = []

  if (!input.propertyId.trim()) {
    violations.push({ field: 'propertyId', message: 'A unit must belong to a property.' })
  }
  if (!input.name.trim()) {
    violations.push({ field: 'name', message: 'Give the unit a name, e.g. "Main house" or "ADU".' })
  }
  if (!(UNIT_STATUSES as readonly string[]).includes(input.status)) {
    violations.push({ field: 'status', message: 'Choose a status.' })
  }

  // NaN comparisons are always false (see packages/core/property/validate.ts
  // for the same guard and why) - checked explicitly so a malformed direct
  // call cannot slip a garbage number past a range check that looks correct.
  if (
    input.marketRentCents != null &&
    (Number.isNaN(input.marketRentCents) ||
      !Number.isInteger(input.marketRentCents) ||
      input.marketRentCents < 0)
  ) {
    violations.push({
      field: 'marketRentCents',
      message: 'Enter a whole-dollar market rent of $0 or more.',
    })
  }
  if (
    input.bedrooms != null &&
    (Number.isNaN(input.bedrooms) || input.bedrooms < 0 || input.bedrooms > 20)
  ) {
    violations.push({ field: 'bedrooms', message: 'Enter a realistic number of bedrooms.' })
  }
  if (
    input.bathrooms != null &&
    (Number.isNaN(input.bathrooms) || input.bathrooms < 0 || input.bathrooms > 20)
  ) {
    violations.push({ field: 'bathrooms', message: 'Enter a realistic number of bathrooms.' })
  }
  if (
    input.squareFeet != null &&
    (Number.isNaN(input.squareFeet) || input.squareFeet < 0 || input.squareFeet > 20_000)
  ) {
    violations.push({ field: 'squareFeet', message: 'Enter a realistic square footage.' })
  }

  return violations
}
