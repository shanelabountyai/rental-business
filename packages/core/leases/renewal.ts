// The renewal rent-increase guard (LEASE-09, R-065; D-4).
//
// "Given a rent increase exceeding the property's jurisdiction cap or notice
// period, when I draft the offer, then the system blocks/warns with the
// specific rule." Two DIFFERENT rules, two different postures, mirroring the
// distinction R-027's entryDecision() already draws between a hard limit and
// a warn-and-override one:
//
//   - A statutory CAP is a ceiling that cannot be legally exceeded whatever
//     the reason - there is no business justification that makes an illegal
//     rent increase legal, so this BLOCKS with no override, the same
//     posture `validateDepositAmount` already takes for an over-collected
//     deposit.
//   - A NOTICE-PERIOD shortfall is a timing problem, not a ceiling - the
//     same shape R-027's entry-notice warn-and-override already gives a
//     visit scheduled too soon, and R-055's retaliation guard gives a rent
//     raise inside its own window: staff can proceed with a stated reason,
//     which is recorded.
//
// Only a RAISE triggers either check - the same "a raise, not any change"
// call R-055's own guard makes. A renewal that holds rent flat or lowers it
// needs neither the statutory ceiling nor the statutory notice.
//
// Pure and DB-free, matching every other packages/core/leases/*.ts file's
// split: the caller (apps/web/lib/leases/renewal-check.ts) reads the
// JurisdictionRule; this decides what it means.

interface Violation {
  field: string
  message: string
}

export type RenewalRentBasis = 'within_limits' | 'capped' | 'insufficient_notice'

export interface RenewalRentCheckInput {
  currentRentCents: number
  proposedRentCents: number
  /// When the new rent takes effect - the successor lease's `startsOn`.
  effectiveOn: Date
  /// When the offer is being drafted - `new Date()` in the ordinary case.
  offeredOn: Date
  /// JurisdictionRule.rentIncreaseCapPercentBps. Null means no statutory
  /// ceiling on file, not "unlimited" - the check is simply not applied,
  /// same posture every other nullable jurisdiction number takes.
  rentIncreaseCapPercentBps: number | null
  /// JurisdictionRule.rentIncreaseNoticeDays. Null means not configured.
  rentIncreaseNoticeDays: number | null
}

export interface RenewalRentDecision {
  basis: RenewalRentBasis
  /// True only for a cap violation - no override exists for this basis.
  blocked: boolean
  /// True only for a notice-period shortfall - staff may proceed with a
  /// stated, recorded reason.
  needsOverride: boolean
  /// The increase as basis points of the CURRENT rent. Zero or negative for
  /// a hold or a decrease, in which case neither check ever applies.
  increasePercentBps: number
  capPercentBps?: number
  /// The highest PROPOSED rent that stays inside the cap, shown so staff
  /// can offer that number instead of guessing at one.
  maxAllowedCents?: number
  noticeDaysGiven?: number
  requiredNoticeDays?: number
  shortfallDays?: number
}

/**
 * Checks a proposed renewal rent against the property's jurisdiction rule.
 *
 * Order matters: the cap is checked first and, if violated, is the whole
 * answer - a rent nobody may lawfully charge is not also worth flagging for
 * short notice, and blocking short-circuits before the days are computed.
 */
export function renewalRentCheck(input: RenewalRentCheckInput): RenewalRentDecision {
  const increasePercentBps =
    input.proposedRentCents > input.currentRentCents
      ? Math.round(
          ((input.proposedRentCents - input.currentRentCents) / input.currentRentCents) * 10_000,
        )
      : 0

  if (increasePercentBps <= 0) {
    return { basis: 'within_limits', blocked: false, needsOverride: false, increasePercentBps }
  }

  if (
    input.rentIncreaseCapPercentBps != null &&
    increasePercentBps > input.rentIncreaseCapPercentBps
  ) {
    return {
      basis: 'capped',
      blocked: true,
      needsOverride: false,
      increasePercentBps,
      capPercentBps: input.rentIncreaseCapPercentBps,
      maxAllowedCents:
        input.currentRentCents +
        Math.floor((input.currentRentCents * input.rentIncreaseCapPercentBps) / 10_000),
    }
  }

  if (input.rentIncreaseNoticeDays != null) {
    const msPerDay = 24 * 60 * 60 * 1000
    const noticeDaysGiven = Math.floor(
      (input.effectiveOn.getTime() - input.offeredOn.getTime()) / msPerDay,
    )
    if (noticeDaysGiven < input.rentIncreaseNoticeDays) {
      return {
        basis: 'insufficient_notice',
        blocked: false,
        needsOverride: true,
        increasePercentBps,
        noticeDaysGiven,
        requiredNoticeDays: input.rentIncreaseNoticeDays,
        shortfallDays: input.rentIncreaseNoticeDays - noticeDaysGiven,
      }
    }
  }

  return { basis: 'within_limits', blocked: false, needsOverride: false, increasePercentBps }
}

/**
 * Same shape as `validateRetaliationAck` and `validateOverride` (R-027,
 * R-055): a reason typed where none was needed is harmless, but a missing
 * one where the notice-period check demanded it is the difference between a
 * documented business call and an unexplained short-notice increase.
 */
export function validateRenewalOverride(reason: string | null | undefined): Violation[] {
  if (!reason?.trim()) {
    return [
      {
        field: 'overrideReason',
        message:
          "This offer gives less than the state's required notice for a rent increase. State why - it is recorded.",
      },
    ]
  }
  return []
}
