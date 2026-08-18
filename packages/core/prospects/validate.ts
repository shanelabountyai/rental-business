// Prospect validation (LEASE-07, R-058). Hand-rolled, matching every other
// packages/core validate.ts in this repo.
//
// TWO SEPARATE INPUT SHAPES, deliberately never merged into one form: the
// inquiry (who is asking) and the pre-screening answers (the identical five
// questions LEASE-07 names) arrive at different times, from different
// pages, and the fair-housing requirement is specifically that the SECOND
// half never varies by who is answering - keeping them as two functions is
// what makes that impossible to blur by accident.

interface Violation {
  field: string
  message: string
}

/// Monthly gross household income, in dollars - closed vocabulary rather
/// than a free-text field, so "how much do prospects who convert typically
/// report" is ever answerable and every prospect sees the identical choices
/// (the same fair-housing reasoning that keeps the five questions fixed).
/// Buckets, not a number: asking for an exact figure invites a precision
/// this pre-screening stage does not need and the real screening criteria
/// (LEASE-04) is where an actual verified figure belongs.
export const INCOME_RANGES = [
  'UNDER_3000',
  'RANGE_3000_5000',
  'RANGE_5000_8000',
  'OVER_8000',
] as const
export type IncomeRange = (typeof INCOME_RANGES)[number]

const INCOME_RANGE_SET: ReadonlySet<string> = new Set(INCOME_RANGES)

export function isIncomeRange(value: string): value is IncomeRange {
  return INCOME_RANGE_SET.has(value)
}

export interface ProspectInquiryInput {
  listingId: string
  firstName: string
  lastName: string
  email?: string | null
  phone?: string | null
  message?: string | null
}

export function validateProspectInquiry(input: ProspectInquiryInput): Violation[] {
  const violations: Violation[] = []

  if (!input.listingId.trim()) {
    violations.push({ field: 'listingId', message: 'Which listing is this about?' })
  }
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

  return violations
}

export interface PrescreenAnswersInput {
  /// Already parsed (or null if unparseable/blank) - the action layer reads
  /// the raw form string, same split every other date field in this
  /// codebase uses (see leases/actions.ts's own parseLeaseDate call).
  moveDate: Date | null
  occupants: number | null
  petsDescription?: string | null
  incomeRange: string | null
  priorEvictions: boolean | null
  priorEvictionsDetail?: string | null
}

export function validatePrescreenAnswers(input: PrescreenAnswersInput): Violation[] {
  const violations: Violation[] = []

  if (!input.moveDate || Number.isNaN(input.moveDate.getTime())) {
    violations.push({ field: 'moveDate', message: 'Choose the date you would move in.' })
  }
  if (
    input.occupants == null ||
    Number.isNaN(input.occupants) ||
    !Number.isInteger(input.occupants) ||
    input.occupants < 1 ||
    input.occupants > 20
  ) {
    violations.push({ field: 'occupants', message: 'Enter a realistic number of occupants (1-20).' })
  }
  if (!input.incomeRange || !isIncomeRange(input.incomeRange)) {
    violations.push({ field: 'incomeRange', message: 'Choose an income range.' })
  }
  // Explicitly answered, not merely truthy - a prior-evictions question
  // left blank is not the same fact as "no", and the difference matters
  // enough here that null is its own violation rather than defaulting to
  // whichever answer happens to look safer.
  if (input.priorEvictions == null) {
    violations.push({ field: 'priorEvictions', message: 'Answer yes or no.' })
  }
  if (input.priorEvictions === true && !input.priorEvictionsDetail?.trim()) {
    violations.push({
      field: 'priorEvictionsDetail',
      message: 'Say briefly what happened - this does not disqualify you on its own.',
    })
  }

  return violations
}
