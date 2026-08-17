// Listing validation (LEASE-01, R-056). Hand-rolled, matching
// packages/core/units and packages/core/property's style rather than a
// schema library.

interface Violation {
  field: string
  message: string
}

export interface ListingInput {
  unitId: string
  headline?: string | null
  description?: string | null
  rentCents: number
  depositCents?: number | null
  /// Already parsed (or null if unparseable/blank) - the action layer reads
  /// the raw form string, the same split every other date field in this
  /// codebase uses (see leases/actions.ts's own parseLeaseDate call).
  availableOn: Date | null
  requirements?: string | null
  petsAllowed: boolean
  petPolicyText?: string | null
}

export function validateListing(input: ListingInput): Violation[] {
  const violations: Violation[] = []

  if (!input.unitId.trim()) {
    violations.push({ field: 'unitId', message: 'A listing must belong to a unit.' })
  }

  if (
    Number.isNaN(input.rentCents) ||
    !Number.isInteger(input.rentCents) ||
    input.rentCents <= 0
  ) {
    violations.push({ field: 'rentCents', message: 'Enter a whole-dollar rent greater than $0.' })
  }

  if (
    input.depositCents != null &&
    (Number.isNaN(input.depositCents) ||
      !Number.isInteger(input.depositCents) ||
      input.depositCents < 0)
  ) {
    violations.push({
      field: 'depositCents',
      message: 'Enter a whole-dollar deposit of $0 or more, or leave it blank.',
    })
  }

  if (!input.availableOn || Number.isNaN(input.availableOn.getTime())) {
    violations.push({ field: 'availableOn', message: 'Choose the date this unit is available.' })
  }

  if (input.petsAllowed && !input.petPolicyText?.trim()) {
    // Not required when pets are refused - "no pets" says everything a
    // prospective tenant needs to know on its own.
    violations.push({
      field: 'petPolicyText',
      message: 'Say what the pet policy actually is - breed, size, fee, deposit.',
    })
  }

  return violations
}
