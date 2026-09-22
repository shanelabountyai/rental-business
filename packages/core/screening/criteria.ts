// Validation for a new ScreeningCriteria version (LEASE-04, R-060, R-242;
// OQ-6). The seeded v1 row is a placeholder an owner drafted with no
// attorney review (07-decisions.md OQ-6) - this is the gate a LATER version
// has to clear, so "draft defaults now, review before real use" has an
// actual mechanism instead of staying a sentence in a decisions log.
//
// `reviewedBy` is REQUIRED here, unlike JurisdictionRule's own gate (which
// only blocks a jurisdiction's founding version - later versions may still
// be saved unreviewed, D-4). ScreeningCriteria has no such founding
// exception: the seeded placeholder already exists and is already
// unreviewed, so every version this form can create is the moment OQ-6
// either gets closed or stays open on purpose - there is no later,
// less-consequential version to defer the requirement to.

export interface ScreeningCriteriaInput {
  incomeToRentMultiplierX100: number
  minCreditScore: number | null
  evictionLookbackMonths: number
  criminalLookbackMonths: number
  citation: string | null
  reviewedBy: string | null
  notes: string | null
}

export interface FieldViolation {
  field: string
  message: string
}

export function validateCriteriaInput(input: ScreeningCriteriaInput): FieldViolation[] {
  const violations: FieldViolation[] = []

  if (!Number.isFinite(input.incomeToRentMultiplierX100) || input.incomeToRentMultiplierX100 <= 0) {
    violations.push({
      field: 'incomeToRentMultiplierX100',
      message: 'Income-to-rent multiplier must be greater than zero.',
    })
  }

  if (
    input.minCreditScore != null &&
    (!Number.isFinite(input.minCreditScore) || input.minCreditScore < 300 || input.minCreditScore > 850)
  ) {
    violations.push({
      field: 'minCreditScore',
      message: 'Credit floor must be between 300 and 850, or blank for no floor.',
    })
  }

  if (!Number.isInteger(input.evictionLookbackMonths) || input.evictionLookbackMonths < 0) {
    violations.push({
      field: 'evictionLookbackMonths',
      message: 'Eviction lookback must be zero or more whole months.',
    })
  }

  if (!Number.isInteger(input.criminalLookbackMonths) || input.criminalLookbackMonths < 0) {
    violations.push({
      field: 'criminalLookbackMonths',
      message: 'Criminal lookback must be zero or more whole months.',
    })
  }

  if (!input.reviewedBy) {
    violations.push({
      field: 'reviewedBy',
      message: 'A reviewer is required - this version cannot govern a real applicant otherwise (OQ-6).',
    })
  }

  return violations
}
