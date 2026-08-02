// Address validation and duplicate-detection, without a geocoding provider.
//
// PROP-01 asks for two things under one word, "validated/geocoded": that the
// address is well-formed, and that a duplicate is caught before a second
// record is created. Both are delivered here with no external dependency.
// True geocoding - turning the address into a real lat/lng - is deliberately
// NOT built: nothing in the product reads Property.latitude/longitude yet (no
// map view, no distance calc, no consumer anywhere in the backlog), and the
// PRD's integrations section names a vendor for Stripe, Resend and Twilio but
// not for geocoding. Building a simulated adapter for a field nothing
// consumes is exactly the speculative infrastructure this codebase's working
// conventions warn against. The columns stay nullable; whichever item first
// needs real coordinates picks a provider and fills them in then.

const ZIP_PATTERN = /^\d{5}(-\d{4})?$/

export interface AddressInput {
  addressLine1: string
  addressLine2?: string | null
  city: string
  state: string
  postalCode: string
}

export interface AddressViolation {
  field: keyof AddressInput
  code: 'required' | 'invalid_zip'
  message: string
}

export function validateAddress(input: AddressInput): AddressViolation[] {
  const violations: AddressViolation[] = []

  if (!input.addressLine1.trim()) {
    violations.push({
      field: 'addressLine1',
      code: 'required',
      message: 'Street address is required.',
    })
  }
  if (!input.city.trim()) {
    violations.push({
      field: 'city',
      code: 'required',
      message: 'City is required.',
    })
  }
  if (!input.state.trim()) {
    violations.push({
      field: 'state',
      code: 'required',
      message: 'State is required.',
    })
  }
  if (!input.postalCode.trim()) {
    violations.push({
      field: 'postalCode',
      code: 'required',
      message: 'ZIP code is required.',
    })
  } else if (!ZIP_PATTERN.test(input.postalCode.trim())) {
    violations.push({
      field: 'postalCode',
      code: 'invalid_zip',
      message: 'Use a 5-digit ZIP, or ZIP+4 (12345 or 12345-6789).',
    })
  }

  return violations
}

/// Street-suffix spellings folded to one form before comparison, so "125 Elm
/// St" and "125 Elm Street" collide. Deliberately small: this catches the
/// realistic case of the same person typing the same address twice, not every
/// USPS abbreviation - a full standardization pass belongs to a real
/// geocoding provider, not a hand-rolled list.
const SUFFIX_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bstreet\b/g, 'st'],
  [/\bavenue\b/g, 'ave'],
  [/\bboulevard\b/g, 'blvd'],
  [/\bdrive\b/g, 'dr'],
  [/\bcourt\b/g, 'ct'],
  [/\blane\b/g, 'ln'],
  [/\broad\b/g, 'rd'],
  [/\bplace\b/g, 'pl'],
  [/\bterrace\b/g, 'ter'],
  [/\bcircle\b/g, 'cir'],
  [/\bapartment\b/g, 'apt'],
  [/\bsuite\b/g, 'ste'],
  [/\bnorth\b/g, 'n'],
  [/\bsouth\b/g, 's'],
  [/\beast\b/g, 'e'],
  [/\bwest\b/g, 'w'],
]

/**
 * A comparison key for "is this the same address someone already entered",
 * not a mailing-ready standardized address. Case-folded, punctuation
 * stripped, common suffixes folded, whitespace collapsed. Only line 1 and the
 * 5-digit ZIP participate - line 2 (unit/apt) is deliberately excluded, since
 * a duplicate-WARNING should fire for two different units at the same street
 * address too (that is the scenario PROP-01's warning exists to catch: a
 * second record for a property that already has one).
 */
export function addressComparisonKey(
  input: Pick<AddressInput, 'addressLine1' | 'postalCode'>,
): string {
  const foldedLine1 = SUFFIX_FOLDS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    input.addressLine1.toLowerCase(),
  )
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const zip5 = input.postalCode.trim().slice(0, 5)

  return `${foldedLine1}|${zip5}`
}
