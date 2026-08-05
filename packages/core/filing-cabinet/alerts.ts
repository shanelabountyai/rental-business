// Filing-cabinet alert windows (PROP-06, R-015): "report, not automated
// action" - same posture as documents/retention.ts's retentionCutoff. These
// functions say what is coming up; nothing here sends anything. Real
// delivery is R-016 (notification engine) / R-077 (compliance calendar),
// neither of which exists yet.
//
// ARM-adjustment and balloon-maturity windows are this build's own proposed
// defaults, not a PRD-given number - same "common practice, not a citation"
// posture R-010 used for its seeded jurisdiction rule. The insurance window
// is the one PRD-given number here: master PRD PROP-06 says "45-60 days
// out"; this uses the wider, safer end as the single trigger since a
// configurable lead time is out of scope.

export const ARM_ADJUSTMENT_ALERT_DAYS = 60
export const BALLOON_MATURITY_ALERT_DAYS = 180
export const INSURANCE_RENEWAL_ALERT_DAYS = 60

const DAY_MS = 24 * 60 * 60 * 1000

/// True when `target` is today or later, and within `days` of `asOf` -
/// never true for a date already in the past, so a stale unattended alert
/// does not resurface forever.
function withinAlertWindow(target: Date | null | undefined, asOf: Date, days: number): boolean {
  if (!target) return false
  const diffMs = target.getTime() - asOf.getTime()
  return diffMs >= 0 && diffMs <= days * DAY_MS
}

export interface MortgageAlertInput {
  rateType: string
  armAdjustmentDate: Date | null
  isBalloon: boolean
  maturityDate: Date | null
}

export function mortgageArmAdjustmentDue(mortgage: MortgageAlertInput, asOf: Date): boolean {
  return mortgage.rateType === 'ARM' && withinAlertWindow(mortgage.armAdjustmentDate, asOf, ARM_ADJUSTMENT_ALERT_DAYS)
}

export function mortgageBalloonMaturityDue(mortgage: MortgageAlertInput, asOf: Date): boolean {
  return mortgage.isBalloon && withinAlertWindow(mortgage.maturityDate, asOf, BALLOON_MATURITY_ALERT_DAYS)
}

export function insuranceRenewalDue(renewsOn: Date, asOf: Date): boolean {
  return withinAlertWindow(renewsOn, asOf, INSURANCE_RENEWAL_ALERT_DAYS)
}
