// The delinquency-to-eviction path as a case file (PAY-14, R-083).
//
// THIS MODULE NEVER FILES ANYTHING ANYWHERE. It records what an owner and
// their attorney did, with dates and evidence, so the file can be handed to
// counsel. Nothing here transmits to a court, a clerk, or a process server,
// and no function in this domain makes a legal judgement on the owner's
// behalf - `packages/core/notices` already established that posture for
// notice text (NOTICE_DISCLAIMER) and it holds doubly here.

/**
 * Where a case has got to. PAY-14's own sequence: notice → filing → court
 * date → judgment → writ → lockout.
 *
 * ORDER IS REAL HERE, unlike `TurnoverStage`, whose own schema comment says
 * it is "not a hard sequence the database enforces". A writ cannot precede a
 * judgment and a judgment cannot precede a filing - that is not house style,
 * it is how the courts work, and a case file that let a PM record them out
 * of order would be evidence of nothing. `canAdvanceTo()` below is where
 * that is enforced; the database still stores a plain enum, matching
 * `WorkOrderStatus`.
 */
export const EVICTION_STAGES = [
  'NOTICE',
  'FILING',
  'COURT',
  'JUDGMENT',
  'WRIT',
  'LOCKOUT',
  'CLOSED',
] as const
export type EvictionStageValue = (typeof EVICTION_STAGES)[number]

export function isEvictionStage(value: string): value is EvictionStageValue {
  return (EVICTION_STAGES as readonly string[]).includes(value)
}

export const EVICTION_STAGE_LABELS: Record<EvictionStageValue, string> = {
  NOTICE: 'Notice served',
  FILING: 'Filed with the court',
  COURT: 'Court date set',
  JUDGMENT: 'Judgment entered',
  WRIT: 'Writ of possession issued',
  LOCKOUT: 'Lockout executed',
  CLOSED: 'Closed',
}

/**
 * How a case ended. `CLOSED` is the only stage that carries one, and it is
 * required there - "this case is over" without saying how is exactly the
 * record that helps nobody a year later.
 *
 * CASH_FOR_KEYS is first-class, not an "other" (PAY-14 names it explicitly as
 * "a documented alternative outcome"). It is also the outcome most likely to
 * be the RIGHT one commercially, and burying it in a free-text note is how a
 * product quietly nudges an owner toward the courtroom.
 */
export const EVICTION_OUTCOMES = [
  'PAID_AND_CURED',
  'CASH_FOR_KEYS',
  'VOLUNTARY_MOVE_OUT',
  'JUDGMENT_FOR_OWNER',
  'JUDGMENT_FOR_TENANT',
  'DISMISSED',
  'WITHDRAWN',
] as const
export type EvictionOutcomeValue = (typeof EVICTION_OUTCOMES)[number]

export function isEvictionOutcome(value: string): value is EvictionOutcomeValue {
  return (EVICTION_OUTCOMES as readonly string[]).includes(value)
}

export const EVICTION_OUTCOME_LABELS: Record<EvictionOutcomeValue, string> = {
  PAID_AND_CURED: 'Tenant paid and cured',
  CASH_FOR_KEYS: 'Cash for keys — agreed move-out',
  VOLUNTARY_MOVE_OUT: 'Tenant moved out voluntarily',
  JUDGMENT_FOR_OWNER: 'Judgment for the owner',
  JUDGMENT_FOR_TENANT: 'Judgment for the tenant',
  DISMISSED: 'Dismissed',
  WITHDRAWN: 'Withdrawn by the owner',
}

/// Position in the ladder. CLOSED is deliberately outside it - a case can
/// close from anywhere, so it has no rung of its own to compare against.
const LADDER: readonly EvictionStageValue[] = [
  'NOTICE',
  'FILING',
  'COURT',
  'JUDGMENT',
  'WRIT',
  'LOCKOUT',
]

export type StageRefusal =
  /// Backwards through the ladder. A case that went wrong does not get
  /// rewound - it closes (WITHDRAWN/DISMISSED) and a new one opens, so the
  /// abandoned attempt stays on the record where an attorney can see it.
  | 'not_backwards'
  /// Skipping a rung - a writ without a judgment, a judgment with no filing.
  | 'skips_a_stage'
  /// Nothing follows CLOSED. Reopening is a new case.
  | 'already_closed'

export interface StageDecision {
  allowed: boolean
  refusal?: StageRefusal
}

/**
 * Whether a case may move from `from` to `to`.
 *
 * Forward one rung at a time, or close from anywhere. Closing is always
 * available because the commercially right answer - the tenant pays, or takes
 * cash for keys, or simply leaves - can arrive at any point, and a product
 * that made "we settled" harder to record than "we got a writ" would be
 * telling the owner something it has no business telling them.
 */
export function canAdvanceTo(from: EvictionStageValue, to: EvictionStageValue): StageDecision {
  if (from === 'CLOSED') return { allowed: false, refusal: 'already_closed' }
  if (to === 'CLOSED') return { allowed: true }

  const fromRung = LADDER.indexOf(from)
  const toRung = LADDER.indexOf(to)
  if (toRung <= fromRung) return { allowed: false, refusal: 'not_backwards' }
  if (toRung > fromRung + 1) return { allowed: false, refusal: 'skips_a_stage' }
  return { allowed: true }
}

export const STAGE_REFUSAL_MESSAGES: Record<StageRefusal, string> = {
  not_backwards:
    'A case does not move backwards. Close this one (withdrawn or dismissed) and open a new case, so the attempt stays on the record.',
  skips_a_stage: 'Record each stage in turn — the dates and their order are the evidence.',
  already_closed: 'This case is closed. Reopening means opening a new case.',
}
