// Validation for lease writes (LEASE-06, R-033). Hand-rolled, matching every
// other packages/core validate.ts in this repo.

import { activationGaps } from './status.ts'

/// Not exported: same shape as every other module's local Violation. See
/// packages/core/units/validate.ts for why this is never re-exported.
interface Violation {
  field: string
  message: string
}

export interface LeaseInput {
  unitId: string
  startsOn: string
  endsOn?: string | null
  rentDollars: string
  depositDollars?: string | null
  /// What this lease provides for if a payment is returned (R-039a). Blank
  /// is a meaningful answer - the lease is silent, so there is no fee - and
  /// is NOT the same as "0", which is a lease that expressly charges nothing.
  nsfFeeDollars?: string | null
  /// How the deposit is held (R-041). Absent is read as CASH, which is what
  /// every lease created before the field existed is.
  depositArrangement?: string | null
  rentDueDay: string
  isMonthToMonth: boolean
  mtmRentDollars?: string | null
}

/// LEASE-06's utility responsibility matrix. Free-form beyond this list is
/// a lease-template concern (R-063) - what matters here is that the common
/// ones have a stable key so a later template can merge against them.
export const UTILITIES = [
  'electricity',
  'gas',
  'water',
  'sewer',
  'trash',
  'internet',
  'lawn',
  'pest',
] as const
export type Utility = (typeof UTILITIES)[number]

export const UTILITY_PAYERS = ['TENANT', 'LANDLORD', 'NOT_APPLICABLE'] as const
export type UtilityPayer = (typeof UTILITY_PAYERS)[number]

function dollarsToCents(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  // Rounded, not truncated: 12.005 entered by hand is a typo, and either
  // way the money is stored as integer cents, never a float.
  return Math.round(value * 100)
}

export function leaseCents(raw: string | null | undefined): number | null {
  return dollarsToCents(raw)
}

export function validateLease(input: LeaseInput): Violation[] {
  const violations: Violation[] = []

  if (!input.unitId.trim()) {
    violations.push({ field: 'unitId', message: 'Choose the unit.' })
  }

  const startsOn = parseDate(input.startsOn)
  if (!startsOn) {
    violations.push({ field: 'startsOn', message: 'When does the tenancy start?' })
  }

  const endsOn = input.endsOn?.trim() ? parseDate(input.endsOn) : null
  if (input.endsOn?.trim() && !endsOn) {
    violations.push({ field: 'endsOn', message: 'That end date could not be read.' })
  }

  const rentCents = dollarsToCents(input.rentDollars)
  if (rentCents == null || rentCents < 0) {
    violations.push({ field: 'rentDollars', message: 'Enter the monthly rent.' })
  }

  const depositCents = dollarsToCents(input.depositDollars)
  if (input.depositDollars?.trim() && (depositCents == null || depositCents < 0)) {
    violations.push({ field: 'depositDollars', message: 'Enter a deposit of $0 or more.' })
  }

  // The arrangement and the amount have to agree (R-041). The statutory cap
  // itself is checked where the jurisdiction rule is available - this
  // function is pure and has no property to look one up for - but the
  // contradiction between "a surety bond" and "and also $1,500 of the
  // tenant's cash" needs no rule to spot, and it is the one that sends
  // somebody hunting at move-out for money nobody ever collected.
  const arrangement = input.depositArrangement ?? 'CASH'
  if (arrangement !== 'CASH' && (depositCents ?? 0) > 0) {
    violations.push({
      field: 'depositDollars',
      message:
        arrangement === 'SURETY_BOND'
          ? 'This lease uses a surety bond, so no cash deposit is held. Set the amount to zero.'
          : 'This lease holds no deposit. Set the amount to zero.',
    })
  }
  if (!['CASH', 'SURETY_BOND', 'NONE'].includes(arrangement)) {
    violations.push({ field: 'depositArrangement', message: 'Choose how the deposit is held.' })
  }

  const nsfFeeCents = dollarsToCents(input.nsfFeeDollars)
  if (input.nsfFeeDollars?.trim() && (nsfFeeCents == null || nsfFeeCents < 0)) {
    violations.push({
      field: 'nsfFeeDollars',
      message: 'Enter a returned-payment fee of $0 or more, or leave it blank.',
    })
  }

  const dueDay = Number(input.rentDueDay)
  // Capped at 28, not 31: a lease due on the 30th has no due date in
  // February, and every downstream billing anchor (R-034) would have to
  // invent one. Anything later than the 28th is expressed as "the last
  // day", which is a template concern, not a number here.
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) {
    violations.push({
      field: 'rentDueDay',
      message: 'Rent is due on a day from 1 to 28 — later than that has no equivalent in February.',
    })
  }

  const mtmRentCents = dollarsToCents(input.mtmRentDollars)
  if (input.mtmRentDollars?.trim() && (mtmRentCents == null || mtmRentCents < 0)) {
    violations.push({
      field: 'mtmRentDollars',
      message: 'Enter a month-to-month rent of $0 or more.',
    })
  }

  // The structural checks activation will apply anyway, surfaced at entry
  // time so a lease is not saved in a shape that can never go live.
  if (startsOn && rentCents != null) {
    for (const gap of activationGaps({
      status: 'DRAFT',
      tenantCount: 1, // parties are added separately; not this form's job
      rentCents,
      startsOn,
      endsOn,
      isMonthToMonth: input.isMonthToMonth,
    })) {
      violations.push({ field: 'endsOn', message: capitalize(gap) + '.' })
    }
  }

  return violations
}

export interface GuarantorInput {
  firstName: string
  lastName: string
  email?: string | null
  phone?: string | null
}

/**
 * A guarantor (LEASE-06: "a distinct role: screened, financially liable on
 * the ledger, no portal access to maintenance/comms").
 *
 * The "no portal access" half is STRUCTURAL, not a permission check: a
 * Guarantor is its own model and is not a Tenant, and the portal
 * authenticates Tenants. There is no flag to get wrong. What this validates
 * is only that the person is identifiable enough to pursue - a guarantor
 * with no contact route is a signature with nobody behind it.
 */
export function validateGuarantor(input: GuarantorInput): Violation[] {
  const violations: Violation[] = []
  if (!input.firstName.trim()) {
    violations.push({ field: 'firstName', message: 'First name.' })
  }
  if (!input.lastName.trim()) {
    violations.push({ field: 'lastName', message: 'Last name.' })
  }
  if (!input.email?.trim() && !input.phone?.trim()) {
    violations.push({
      field: 'email',
      message: 'An email or a phone number — a guarantor nobody can reach is a signature with nobody behind it.',
    })
  }
  return violations
}

function parseDate(raw: string): Date | null {
  if (!raw?.trim()) return null
  // Date-only, parsed as UTC midnight. `Lease.startsOn` is a @db.Date, so
  // there is no time-of-day to preserve, and parsing "2026-08-01" through
  // the local timezone would land on July 31st for half the world.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Date.UTC(+y!, +m! - 1, +d!))
  return Number.isNaN(date.getTime()) ? null : date
}

export function parseLeaseDate(raw: string): Date | null {
  return parseDate(raw)
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
