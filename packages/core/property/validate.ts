import { isValidTimezone } from '../scheduling/local-time.ts'
import { type AddressInput, validateAddress } from './address.ts'
import { isUsStateCode } from './us-states.ts'

// Validation for LegalEntity and Property writes. Hand-rolled rather than a
// schema library, matching packages/core/auth/password.ts: a small, explicit
// violations list that a form can map straight onto fields, with no new
// dependency for what a few functions cover.

export const LEGAL_ENTITY_TYPES = [
  'LLC',
  'PERSONAL',
  'TRUST',
  'CORPORATION',
  'PARTNERSHIP',
] as const
export type LegalEntityTypeValue = (typeof LEGAL_ENTITY_TYPES)[number]

export const PROPERTY_TYPES = [
  'SINGLE_FAMILY',
  'DUPLEX',
  'TRIPLEX',
  'FOURPLEX',
  'TOWNHOUSE',
  'CONDO',
  'MANUFACTURED',
] as const
export type PropertyTypeValue = (typeof PROPERTY_TYPES)[number]

export interface Violation {
  field: string
  message: string
}

/**
 * A short, human-labeled starting list for the timezone picker - not the
 * whole IANA set (418 zones), which is unusable as a plain dropdown and
 * disproportionate to build a real picker for on a domestic SFR product.
 * `isValidTimezone` still accepts any real IANA zone regardless of what is
 * suggested here, so an operator with a property outside this list types the
 * zone name directly.
 */
export const COMMON_US_TIMEZONES: readonly { value: string; label: string }[] =
  [
    { value: 'America/New_York', label: 'Eastern — America/New_York' },
    { value: 'America/Chicago', label: 'Central — America/Chicago' },
    { value: 'America/Denver', label: 'Mountain — America/Denver' },
    {
      value: 'America/Phoenix',
      label: 'Mountain, no DST — America/Phoenix',
    },
    { value: 'America/Los_Angeles', label: 'Pacific — America/Los_Angeles' },
    { value: 'America/Anchorage', label: 'Alaska — America/Anchorage' },
    { value: 'Pacific/Honolulu', label: 'Hawaii — Pacific/Honolulu' },
  ]

export interface LegalEntityInput {
  name: string
  type: string
  formationState?: string | null
}

export function validateLegalEntity(input: LegalEntityInput): Violation[] {
  const violations: Violation[] = []

  if (!input.name.trim()) {
    violations.push({ field: 'name', message: 'Name is required.' })
  }
  if (!(LEGAL_ENTITY_TYPES as readonly string[]).includes(input.type)) {
    violations.push({ field: 'type', message: 'Choose an entity type.' })
  }
  const formationState = input.formationState?.trim()
  if (formationState && !isUsStateCode(formationState)) {
    violations.push({
      field: 'formationState',
      message: 'Choose a valid US state.',
    })
  }

  return violations
}

export interface PropertyInput extends AddressInput {
  legalEntityId: string
  name: string
  propertyType: string
  /// IANA identifier, e.g. "America/Chicago" - not a UTC offset. Offsets
  /// silently break across DST (D-3); the whole point of storing a zone name
  /// is that the runtime resolves the correct offset for whatever date a job
  /// actually runs on.
  timezone: string
  bedrooms?: number | null
  bathrooms?: number | null
  yearBuilt?: number | null
  /// ISO date string (yyyy-mm-dd) from a <input type="date">, or empty.
  acquiredOn?: string | null
  /// R-168: the date this owner's OWN records begin for this property - not
  /// when it was bought (`acquiredOn` above), when it changes hands to
  /// somebody's cousin who ran it off a spreadsheet for six years. Reports
  /// that window by period (the operating snapshot, the tax export) clamp
  /// their start no earlier than this, so a property imported mid-year does
  /// not report every day before the migration as a mysteriously vacant,
  /// income-free stretch nobody can explain. Null means no such gap is
  /// known - every property built through the ordinary create form.
  historyStartsOn?: string | null
  /// Freeform, staff-set - "Dallas-Fort Worth" - used only to target segment
  /// announcements (R-053, COMM-04). No validation: two properties
  /// disagreeing on spelling just fail to group together on the segment
  /// picker.
  metro?: string | null
  /// Freeform ad-hoc labels, same reasoning as `metro` (R-053, COMM-04).
  tags?: string[]
  /// R-063's lease-addenda triggers (LEASE-06). No validation - same
  /// posture as `metro`: a boolean or a note is true or it is not, and
  /// there is nothing to check it against.
  hasPool?: boolean
  hasWellOrSeptic?: boolean
  moldHistoryNotes?: string | null
  bedbugHistoryNotes?: string | null
}

const CURRENT_YEAR = new Date().getUTCFullYear()

export function validateProperty(input: PropertyInput): Violation[] {
  const violations: Violation[] = validateAddress(input).map((v) => ({
    field: v.field,
    message: v.message,
  }))

  if (!input.legalEntityId.trim()) {
    violations.push({
      field: 'legalEntityId',
      message: 'Choose which entity owns this property.',
    })
  }
  if (!input.name.trim()) {
    violations.push({ field: 'name', message: 'Give the property a name.' })
  }
  // Only checked when non-empty: validateAddress() above already reports a
  // blank state as "required", and reporting both would show two messages
  // for one field.
  const state = input.state.trim()
  if (state && !isUsStateCode(state)) {
    violations.push({ field: 'state', message: 'Choose a valid US state.' })
  }
  if (!(PROPERTY_TYPES as readonly string[]).includes(input.propertyType)) {
    violations.push({
      field: 'propertyType',
      message: 'Choose a property type.',
    })
  }

  // Every nightly job for this property runs in whatever zone is stored here
  // (D-3). A garbage value is not a cosmetic error - it silently breaks late
  // fees, reminders and every other scheduled job for this address forever,
  // and R-006's runner only discovers it at 2am with nobody watching.
  if (!input.timezone.trim()) {
    violations.push({ field: 'timezone', message: 'Choose a timezone.' })
  } else if (!isValidTimezone(input.timezone.trim())) {
    violations.push({
      field: 'timezone',
      message: 'That is not a recognized timezone.',
    })
  }

  // NaN comparisons are always false, so `NaN < 0 || NaN > 20` silently passes
  // unless NaN is checked for directly - the browser's number input cannot
  // submit garbage, but a server action is callable directly, and the check
  // has to hold there too.
  if (
    input.bedrooms != null &&
    (Number.isNaN(input.bedrooms) || input.bedrooms < 0 || input.bedrooms > 20)
  ) {
    violations.push({ field: 'bedrooms', message: 'Enter a realistic number of bedrooms.' })
  }
  if (
    input.bathrooms != null &&
    (Number.isNaN(input.bathrooms) ||
      input.bathrooms < 0 ||
      input.bathrooms > 20)
  ) {
    violations.push({ field: 'bathrooms', message: 'Enter a realistic number of bathrooms.' })
  }
  if (
    input.yearBuilt != null &&
    (Number.isNaN(input.yearBuilt) ||
      input.yearBuilt < 1700 ||
      input.yearBuilt > CURRENT_YEAR + 1)
  ) {
    violations.push({
      field: 'yearBuilt',
      message: `Enter a year between 1700 and ${CURRENT_YEAR + 1}.`,
    })
  }
  if (input.acquiredOn) {
    const parsed = new Date(`${input.acquiredOn}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime())) {
      violations.push({ field: 'acquiredOn', message: 'Enter a valid date.' })
    } else if (parsed.getTime() > Date.now()) {
      violations.push({
        field: 'acquiredOn',
        message: 'Acquisition date cannot be in the future.',
      })
    }
  }
  if (input.historyStartsOn) {
    const parsed = new Date(`${input.historyStartsOn}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime())) {
      violations.push({ field: 'historyStartsOn', message: 'Enter a valid date.' })
    } else if (parsed.getTime() > Date.now()) {
      violations.push({
        field: 'historyStartsOn',
        message: 'History cannot start in the future.',
      })
    }
  }

  return violations
}

/// The reserve target and last-counted balance (PAY-11, R-082). Both figures
/// are typed in by a human - see `PropertyReserve`'s own comment for why the
/// balance is not derived - so the validation's job is only to refuse the
/// shapes that would make the report lie.
export interface PropertyReserveInput {
  targetCents: number | null
  balanceCents: number | null
  balanceAsOf?: string | null
}

export function validatePropertyReserve(input: PropertyReserveInput): Violation[] {
  const violations: Violation[] = []

  if (
    input.targetCents == null ||
    Number.isNaN(input.targetCents) ||
    !Number.isInteger(input.targetCents) ||
    input.targetCents < 0
  ) {
    violations.push({ field: 'targetDollars', message: 'Enter a target of $0 or more.' })
  }
  if (
    input.balanceCents != null &&
    (Number.isNaN(input.balanceCents) || !Number.isInteger(input.balanceCents) || input.balanceCents < 0)
  ) {
    violations.push({ field: 'balanceDollars', message: 'Enter a balance of $0 or more, or leave it blank.' })
  }
  if (input.balanceAsOf && Number.isNaN(Date.parse(input.balanceAsOf))) {
    violations.push({ field: 'balanceAsOf', message: 'Enter a valid date.' })
  }
  // A balance with no date is the one combination that is worse than no
  // balance at all: it reads as current for ever. The date is what stops a
  // figure counted eighteen months ago from being trusted as today's.
  if (input.balanceCents != null && !input.balanceAsOf) {
    violations.push({
      field: 'balanceAsOf',
      message: 'Say when this balance was counted — an undated balance always reads as current.',
    })
  }

  return violations
}
