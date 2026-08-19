import type { ChargeType, LateFeeType } from '@rental/db'
import { isUsStateCode } from '../property/us-states.ts'
// Imported from the leaf module, not '../notices/index.ts': this file is
// reachable from a client component (see the note below), so it takes the
// smallest pure thing it needs rather than a barrel.
import { NOTICE_SERVICE_METHODS } from '../notices/service-methods.ts'
import type { ServiceMethodMap } from '../notices/service-methods.ts'

// Validation for JurisdictionRule writes (D-4). Hand-rolled, matching
// packages/core/property and packages/core/units' style rather than a schema
// library.
//
// LateFeeType and ChargeType are TYPE-ONLY imports from the Prisma schema,
// checked against by `satisfies` below - not a runtime import of the
// generated enum object. packages/core/audit/record.ts does the same for
// Prisma types, but that module is never reachable from a client component.
// This one is: apps/web/components/jurisdiction/rule-form.tsx imports
// PAYMENT_ALLOCATION_CHARGE_TYPES from here, and a runtime `import {
// ChargeType } from '@rental/db'` drags the whole generated Prisma client -
// which does `require('fs')` - into the browser bundle. `satisfies` gets the
// same "cannot drift from the schema" guarantee at compile time, for free,
// with nothing shipped to the browser.
interface Violation {
  field: string
  message: string
}

const LATE_FEE_TYPES = [
  'NONE',
  'FLAT',
  'PERCENT_OF_RENT',
  'DAILY',
  'FLAT_PLUS_DAILY',
] as const satisfies readonly LateFeeType[]
const LATE_FEE_TYPE_SET: ReadonlySet<string> = new Set(LATE_FEE_TYPES)

const ALL_CHARGE_TYPES = [
  'RENT',
  'LATE_FEE',
  'NSF_FEE',
  'UTILITY',
  'RUBS_ALLOCATION',
  'PET_RENT',
  'PET_FEE',
  'DEPOSIT',
  'CHARGEBACK',
  'CONCESSION',
  'LEGAL_COST',
  'OTHER',
] as const satisfies readonly ChargeType[]
const CHARGE_TYPES: ReadonlySet<string> = new Set(ALL_CHARGE_TYPES)

/**
 * The charge types a payment can be allocated against, in the order the admin
 * form presents them - rent first, matching the seeded Texas default of
 * paying down rent before fees. DEPOSIT and CONCESSION are excluded: a
 * deposit is not something a rent payment pays down, and a concession is a
 * credit, not a charge.
 *
 * This is a fixed presentation order, not a user-reorderable one - the form
 * lets an admin choose WHICH charge types are included, always in this
 * sequence. A jurisdiction whose statute demands a genuinely different
 * sequence (fees before rent, say) needs a real reorder control; none of the
 * footprint states need that yet, so this is the smaller thing that works
 * today.
 */
export const PAYMENT_ALLOCATION_CHARGE_TYPES = ALL_CHARGE_TYPES.filter(
  (type) => type !== 'DEPOSIT' && type !== 'CONCESSION',
)

export interface JurisdictionRuleInput {
  state: string
  /// City or county for a local ordinance. Null/omitted means statewide.
  jurisdiction?: string | null
  effectiveFrom: Date

  graceDays: number
  lateFeeType: string
  lateFeeFlatCents?: number | null
  lateFeePercentBps?: number | null
  lateFeeDailyCents?: number | null
  lateFeeMaxCents?: number | null
  lateFeeMaxPercentBps?: number | null

  depositMaxBps?: number | null
  depositDispositionDays?: number | null
  depositEscrowRequired: boolean
  depositInterestRequired: boolean

  entryNoticeHours?: number | null
  payOrQuitDays?: number | null
  noticeToVacateDays?: number | null
  rentIncreaseNoticeDays?: number | null
  /// LEASE-09 (R-065). Null means no statutory cap on file, not unlimited.
  rentIncreaseCapPercentBps?: number | null
  justCauseRequired: boolean
  /// RISK-06 (R-055). Null means not configured - the retaliation guard is
  /// simply not applied, never assumed to be zero days.
  retaliationWindowDays?: number | null

  paymentAllocationOrder: string[]
  /// Which service methods serve which notice type here (R-051, COMM-02).
  /// Omitted/null means the state's service rules are simply not configured -
  /// service is still recordable and is flagged unverified, never refused.
  noticeServiceMethods?: ServiceMethodMap | null
  applicationFeeCapCents?: number | null
  rubsPermitted: boolean
  /// LEASE-01 (R-056). Null means unreviewed - see the schema's own comment
  /// on this column.
  sourceOfIncomeProtected?: boolean | null

  citation?: string | null
  reviewedBy?: string | null
  notes?: string | null
}

/// A non-negative integer within `max`, or NaN/negative/fractional - the
/// three shapes a hand-typed cents or day count can take that a range check
/// alone would miss. NaN comparisons are always false, so an unguarded
/// `value > max` silently lets NaN through the way it does everywhere else in
/// this codebase (see packages/core/property/validate.ts).
function isWholeNumberInRange(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max
}

export function validateJurisdictionRule(
  input: JurisdictionRuleInput,
): Violation[] {
  const violations: Violation[] = []

  if (!isUsStateCode(input.state)) {
    violations.push({ field: 'state', message: 'Choose a US state.' })
  }
  if (input.jurisdiction != null && !input.jurisdiction.trim()) {
    violations.push({
      field: 'jurisdiction',
      message: 'Leave this blank for a statewide rule, or name a city/county.',
    })
  }
  if (Number.isNaN(input.effectiveFrom.getTime())) {
    violations.push({
      field: 'effectiveFrom',
      message: 'Enter a valid effective date.',
    })
  }

  if (!isWholeNumberInRange(input.graceDays, 60)) {
    violations.push({
      field: 'graceDays',
      message: 'Enter a realistic number of grace days (0–60).',
    })
  }

  if (!LATE_FEE_TYPE_SET.has(input.lateFeeType)) {
    violations.push({ field: 'lateFeeType', message: 'Choose a late-fee type.' })
  }
  validateLateFee(input, violations)

  if (
    input.depositMaxBps != null &&
    !isWholeNumberInRange(input.depositMaxBps, 30_000)
  ) {
    violations.push({
      field: 'depositMaxBps',
      message: 'Enter a realistic deposit cap in basis points, or leave blank for no statutory cap.',
    })
  }
  if (
    input.depositDispositionDays != null &&
    !isWholeNumberInRange(input.depositDispositionDays, 180)
  ) {
    violations.push({
      field: 'depositDispositionDays',
      message: 'Enter a realistic number of disposition days (0–180).',
    })
  }

  if (
    input.entryNoticeHours != null &&
    !isWholeNumberInRange(input.entryNoticeHours, 168)
  ) {
    violations.push({
      field: 'entryNoticeHours',
      message: 'Enter a realistic number of entry-notice hours (0–168).',
    })
  }
  for (const field of [
    'payOrQuitDays',
    'noticeToVacateDays',
    'rentIncreaseNoticeDays',
    'retaliationWindowDays',
  ] as const) {
    const value = input[field]
    if (value != null && !isWholeNumberInRange(value, 365)) {
      violations.push({
        field,
        message: 'Enter a realistic number of days (0–365).',
      })
    }
  }
  if (
    input.rentIncreaseCapPercentBps != null &&
    !isWholeNumberInRange(input.rentIncreaseCapPercentBps, 10_000)
  ) {
    violations.push({
      field: 'rentIncreaseCapPercentBps',
      message: 'Enter a realistic rent-increase cap in basis points, or leave blank for no statutory cap.',
    })
  }

  if (input.paymentAllocationOrder.length === 0) {
    violations.push({
      field: 'paymentAllocationOrder',
      message: 'Choose at least one charge type.',
    })
  } else {
    const seen = new Set<string>()
    for (const chargeType of input.paymentAllocationOrder) {
      if (!CHARGE_TYPES.has(chargeType)) {
        violations.push({
          field: 'paymentAllocationOrder',
          message: `"${chargeType}" is not a charge type.`,
        })
      } else if (seen.has(chargeType)) {
        violations.push({
          field: 'paymentAllocationOrder',
          message: `"${chargeType}" is listed more than once.`,
        })
      }
      seen.add(chargeType)
    }
  }

  if (
    input.applicationFeeCapCents != null &&
    !isWholeNumberInRange(input.applicationFeeCapCents, 100_000_00)
  ) {
    violations.push({
      field: 'applicationFeeCapCents',
      message: 'Enter a realistic application-fee cap, or leave blank for no statutory cap.',
    })
  }

  // Notice service methods (R-051). The MAP is validated, never the question
  // of whether a state "should" allow a method - that is the attorney review
  // `citation`/`reviewedBy` record, not something code can check.
  if (input.noticeServiceMethods != null) {
    for (const [noticeType, methods] of Object.entries(input.noticeServiceMethods)) {
      if (!noticeType.trim()) {
        violations.push({
          field: 'noticeServiceMethods',
          message: 'A notice type cannot be blank.',
        })
        continue
      }
      if (!Array.isArray(methods)) {
        violations.push({
          field: 'noticeServiceMethods',
          message: `Service methods for ${noticeType} must be a list.`,
        })
        continue
      }
      const seenMethods = new Set<string>()
      for (const method of methods) {
        if (!(NOTICE_SERVICE_METHODS as readonly string[]).includes(method)) {
          violations.push({
            field: 'noticeServiceMethods',
            message: `"${method}" is not a service method this product can record proof for.`,
          })
        }
        if (seenMethods.has(method)) {
          violations.push({
            field: 'noticeServiceMethods',
            message: `${noticeType} lists ${method} twice.`,
          })
        }
        seenMethods.add(method)
      }
    }
  }

  return violations
}

/// Which cents/bps fields a late-fee type requires, split out because
/// FLAT_PLUS_DAILY needs two of them and NONE needs none - a single
/// switch-per-field would either duplicate this list or miss a combination.
function validateLateFee(
  input: JurisdictionRuleInput,
  violations: Violation[],
): void {
  const requiresFlat =
    input.lateFeeType === 'FLAT' || input.lateFeeType === 'FLAT_PLUS_DAILY'
  const requiresDaily =
    input.lateFeeType === 'DAILY' || input.lateFeeType === 'FLAT_PLUS_DAILY'
  const requiresPercent = input.lateFeeType === 'PERCENT_OF_RENT'

  if (requiresFlat && !isWholeNumberInRange(input.lateFeeFlatCents ?? Number.NaN, 100_000_00)) {
    violations.push({
      field: 'lateFeeFlatCents',
      message: 'Enter the flat late fee in cents.',
    })
  }
  if (requiresDaily && !isWholeNumberInRange(input.lateFeeDailyCents ?? Number.NaN, 100_000)) {
    violations.push({
      field: 'lateFeeDailyCents',
      message: 'Enter the daily late fee in cents.',
    })
  }
  if (requiresPercent && !isWholeNumberInRange(input.lateFeePercentBps ?? Number.NaN, 10_000)) {
    violations.push({
      field: 'lateFeePercentBps',
      message: 'Enter the late-fee percentage in basis points (100 = 1%).',
    })
  }
  if (
    input.lateFeeType === 'NONE' &&
    (input.lateFeeFlatCents != null ||
      input.lateFeePercentBps != null ||
      input.lateFeeDailyCents != null)
  ) {
    violations.push({
      field: 'lateFeeType',
      message: '"None" cannot carry a fee amount - choose the matching type instead.',
    })
  }

  if (
    input.lateFeeMaxCents != null &&
    !isWholeNumberInRange(input.lateFeeMaxCents, 100_000_00)
  ) {
    violations.push({
      field: 'lateFeeMaxCents',
      message: 'Enter a realistic late-fee cap in cents.',
    })
  }
  if (
    input.lateFeeMaxPercentBps != null &&
    !isWholeNumberInRange(input.lateFeeMaxPercentBps, 10_000)
  ) {
    violations.push({
      field: 'lateFeeMaxPercentBps',
      message: 'Enter a realistic late-fee cap in basis points (100 = 1%).',
    })
  }
}
