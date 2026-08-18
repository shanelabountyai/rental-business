// Application validation (LEASE-03, R-059). Hand-rolled, matching every
// other packages/core validate.ts in this repo.
//
// THREE SEPARATE INPUT SHAPES, deliberately never merged: inviting a
// co-applicant (who needs a link), an applicant's own form (their answers),
// and the fee amount to actually charge (a jurisdiction calculation, not a
// form field) happen at different times, from different pages, by different
// people - keeping them as three functions is what keeps a co-applicant
// invite from ever needing an applicant's own answers to validate, and vice
// versa.

interface Violation {
  field: string
  message: string
}

const MIN_ADULT_AGE_YEARS = 18

export interface CoApplicantInviteInput {
  firstName: string
  lastName: string
  email?: string | null
  phone?: string | null
}

export function validateCoApplicantInvite(input: CoApplicantInviteInput): Violation[] {
  const violations: Violation[] = []

  if (!input.firstName.trim()) {
    violations.push({ field: 'firstName', message: 'Enter a first name.' })
  }
  if (!input.lastName.trim()) {
    violations.push({ field: 'lastName', message: 'Enter a last name.' })
  }
  if (!input.email?.trim() && !input.phone?.trim()) {
    violations.push({
      field: 'email',
      message: 'Enter an email or a phone number - that is how their link gets sent.',
    })
  }

  return violations
}

export interface ApplicantFormInput {
  firstName: string
  lastName: string
  email?: string | null
  phone?: string | null
  /// Already parsed (or null if unparseable/blank), matching every other
  /// date field in this codebase - see prospects' own PrescreenAnswersInput.
  dateOfBirth: Date | null
  currentAddressLine1: string
  currentCity: string
  currentState: string
  currentPostalCode: string
  monthsAtCurrentAddress: number | null
  employerName?: string | null
  monthlyIncomeCents: number | null
}

/**
 * Is this person old enough to be an applicant at all (LEASE-03: "one per
 * adult 18+")? Pure and takes `now` explicitly rather than reading the
 * clock itself, so a birthday landing exactly on the boundary is testable
 * without waiting for it.
 */
export function isAdult(dateOfBirth: Date, now: Date): boolean {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear()
  const monthDiff = now.getUTCMonth() - dateOfBirth.getUTCMonth()
  const dayDiff = now.getUTCDate() - dateOfBirth.getUTCDate()
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age -= 1
  return age >= MIN_ADULT_AGE_YEARS
}

export function validateApplicantForm(input: ApplicantFormInput, now: Date): Violation[] {
  const violations: Violation[] = []

  if (!input.firstName.trim()) {
    violations.push({ field: 'firstName', message: 'Enter a first name.' })
  }
  if (!input.lastName.trim()) {
    violations.push({ field: 'lastName', message: 'Enter a last name.' })
  }
  if (!input.email?.trim() && !input.phone?.trim()) {
    violations.push({
      field: 'email',
      message: 'Enter an email or a phone number - there has to be a way to reach you back.',
    })
  }
  if (!input.dateOfBirth || Number.isNaN(input.dateOfBirth.getTime())) {
    violations.push({ field: 'dateOfBirth', message: 'Enter a date of birth.' })
  } else if (!isAdult(input.dateOfBirth, now)) {
    violations.push({
      field: 'dateOfBirth',
      message: 'Applicants must be 18 or older. A minor is listed as an occupant, not an applicant.',
    })
  }
  if (!input.currentAddressLine1.trim()) {
    violations.push({ field: 'currentAddressLine1', message: 'Enter your current street address.' })
  }
  if (!input.currentCity.trim()) {
    violations.push({ field: 'currentCity', message: 'Enter your current city.' })
  }
  if (!input.currentState.trim()) {
    violations.push({ field: 'currentState', message: 'Enter your current state.' })
  }
  if (!input.currentPostalCode.trim()) {
    violations.push({ field: 'currentPostalCode', message: 'Enter your current postal code.' })
  }
  if (
    input.monthsAtCurrentAddress == null ||
    Number.isNaN(input.monthsAtCurrentAddress) ||
    !Number.isInteger(input.monthsAtCurrentAddress) ||
    input.monthsAtCurrentAddress < 0
  ) {
    violations.push({
      field: 'monthsAtCurrentAddress',
      message: 'Enter how many months you have lived at this address.',
    })
  }
  if (
    input.monthlyIncomeCents == null ||
    Number.isNaN(input.monthlyIncomeCents) ||
    !Number.isInteger(input.monthlyIncomeCents) ||
    input.monthlyIncomeCents < 0
  ) {
    violations.push({ field: 'monthlyIncomeCents', message: 'Enter your monthly income.' })
  }

  return violations
}

/**
 * The amount to actually charge, clamped to the jurisdiction cap (D-4,
 * D-12) - never the asking price alone. Null/zero asking means no fee is
 * configured for this listing, which reads as "nothing due", not "unknown".
 * A cap lower than the asking price wins; a cap higher than (or absent
 * from) the asking price changes nothing, because the cap is a ceiling, not
 * a target.
 */
export function applicationFeeCentsFor(
  askingCents: number | null,
  capCents: number | null,
): number {
  if (!askingCents || askingCents <= 0) return 0
  if (capCents != null && askingCents > capCents) return capCents
  return askingCents
}
