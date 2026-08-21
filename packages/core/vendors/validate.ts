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

// Vendor records themselves (MAINT-11, R-079) - what a PM types managing
// the vendor list, distinct from everything above this line, which is what
// a VENDOR submits through their own magic link.

export interface VendorRecordInput {
  name: string
  trades: readonly string[]
  contactName?: string | null
  email?: string | null
  phone?: string | null
  serviceAreas?: readonly string[]
  licenseNumber?: string | null
  w9OnFile: boolean
  /// A calendar day (`Vendor.coiExpiresOn` is `@db.Date`), or empty for "no
  /// COI on file yet" - not the same as an expired one, which still has a
  /// date, just a past one.
  coiExpiresOn?: string | null
  preferredRank?: number | null
  emergencyAvailable: boolean
}

export function validateVendorRecord(input: VendorRecordInput): Violation[] {
  const violations: Violation[] = []
  if (!input.name.trim()) violations.push({ field: 'name', message: 'Required.' })
  if (input.trades.length === 0) {
    violations.push({ field: 'trades', message: 'Enter at least one trade.' })
  }
  if (
    input.preferredRank != null &&
    (!Number.isInteger(input.preferredRank) || input.preferredRank < 0)
  ) {
    violations.push({ field: 'preferredRank', message: 'Enter a whole number, or leave blank.' })
  }
  if (input.coiExpiresOn && Number.isNaN(new Date(`${input.coiExpiresOn}T00:00:00.000Z`).getTime())) {
    violations.push({ field: 'coiExpiresOn', message: 'Enter a valid date.' })
  }
  return violations
}

/// The channels a landlord actually pays a vendor through - a closed list
/// in code, the same "free-form column, validated here, never a Prisma
/// enum" posture `Notice.type`/`ComplianceItem.type` already take.
export const VENDOR_PAYMENT_METHODS = ['CHECK', 'ACH', 'CARD', 'CASH', 'OTHER'] as const
export type VendorPaymentMethodValue = (typeof VENDOR_PAYMENT_METHODS)[number]

export function isVendorPaymentMethod(value: string): value is VendorPaymentMethodValue {
  return (VENDOR_PAYMENT_METHODS as readonly string[]).includes(value)
}
