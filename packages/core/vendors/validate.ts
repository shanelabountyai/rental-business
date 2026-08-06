// Validation for what a vendor submits through their magic link (MAINT-03,
// R-025). Hand-rolled, matching every other packages/core validate.ts.
//
// Everything here runs against input from an UNAUTHENTICATED party holding a
// bearer token (D-16). That does not make the rules different - it makes
// them the only rules, since there is no staff member about to notice a
// typo.

import { isVendorResponse } from './dispatch.ts'

interface Violation {
  field: string
  message: string
}

export interface VendorResponseInput {
  response: string
  /// Required on a decline, so the PM picking the fallback knows whether
  /// this is "booked until Friday" (ask again next week) or "we don't do
  /// mobile homes" (never ask again).
  declineReason?: string | null
  /// Required when proposing a time.
  proposedStart?: string | null
  proposedEnd?: string | null
}

export function validateVendorResponse(input: VendorResponseInput): Violation[] {
  const violations: Violation[] = []

  if (!isVendorResponse(input.response)) {
    violations.push({ field: 'response', message: 'Choose accept, decline, or propose a time.' })
    return violations
  }

  if (input.response === 'DECLINED' && !input.declineReason?.trim()) {
    violations.push({
      field: 'declineReason',
      message: 'Let us know why, so we can send the right person next.',
    })
  }

  if (input.response === 'PROPOSED_TIME') {
    const start = input.proposedStart?.trim()
    const end = input.proposedEnd?.trim()
    if (!start || Number.isNaN(Date.parse(start))) {
      violations.push({ field: 'proposedStart', message: 'Enter when you can start.' })
    }
    if (!end || Number.isNaN(Date.parse(end))) {
      violations.push({ field: 'proposedEnd', message: 'Enter when you expect to finish.' })
    }
    if (
      start &&
      end &&
      !Number.isNaN(Date.parse(start)) &&
      !Number.isNaN(Date.parse(end)) &&
      Date.parse(end) <= Date.parse(start)
    ) {
      violations.push({ field: 'proposedEnd', message: 'The end time has to be after the start.' })
    }
  }

  return violations
}

export interface VendorInvoiceInput {
  /// Whole cents. Optional: MAINT-03 says "a napkin photo is a valid
  /// invoice", and a napkin does not always have a legible total. The photo
  /// is the artifact; the number is a convenience the PM can fill in later.
  invoiceCents?: number | null
}

export function validateVendorInvoice(input: VendorInvoiceInput): Violation[] {
  if (
    input.invoiceCents != null &&
    (!Number.isInteger(input.invoiceCents) || input.invoiceCents < 0)
  ) {
    return [{ field: 'invoiceCents', message: 'Enter a whole-dollar amount of $0 or more.' }]
  }
  return []
}
