// Habitability keyword detection (MAINT-02, RISK-05), R-019.
//
// `Ticket.habitabilityFlag`'s own schema comment says intake is where it gets
// set: "Set when intake detects habitability language - mold, leak, no heat,
// sewage, infestation." This is that detection. R-023's triage queue reads
// the flag to elevate priority and start a tracked response clock; it does
// not need to re-derive it, because the moment that matters legally is what
// the TENANT actually wrote, not what a later re-scan of edited staff notes
// would find.
//
// A plain keyword scan, not a classifier - these five words/phrases are
// explicitly named in the PRD, and a false positive here costs a habitability
// review that turns out to be routine, while a false negative costs a
// genuine habitability issue quietly sitting in the ordinary queue. That
// asymmetry is exactly why this errs toward over-flagging: substring
// matching on a short, PRD-given list, not language understanding.

import { type DayCountRule, statutoryDeadline } from '../scheduling/deadline.ts'
import type { BusinessDate } from '../scheduling/local-time.ts'

const HABITABILITY_KEYWORDS = [
  'mold',
  'mould',
  'leak',
  'no heat',
  'sewage',
  'infestation',
  'infested',
] as const

/// Whether `text` contains habitability language. Case-insensitive substring
/// match against the whole submitted text (category answers, troubleshooting
/// notes, and any free-text fields), so "no heat in the bedroom" and "MOLD on
/// the ceiling" both flag regardless of where in the request they appear.
export function detectHabitabilityLanguage(text: string): boolean {
  const lower = text.toLowerCase()
  return HABITABILITY_KEYWORDS.some((keyword) => lower.includes(keyword))
}

// ---------------------------------------------------------------------------
// The repair clock (R-217, MAINT-01/RISK-06; D-4)
//
// The one statutory clock in this product that runs AGAINST the owner: in
// many states a tenant's complaint plus a failure to repair within the
// state's period unlocks repair-and-deduct, withholding, termination and
// statutory damages. The flag above has always been the written notice; this
// is the deadline it starts.
//
// The clock starts the day the TICKET was opened, which is the earliest date
// anybody could argue notice was given. Several states only start it at a
// later written or certified notice - counting from the first complaint can
// only make the alarm early, never late, which is the right way for an alarm
// about the owner's own exposure to be wrong.
// ---------------------------------------------------------------------------

export type HabitabilityRepairStage = 'ON_TRACK' | 'HALFWAY' | 'OVERDUE'

export interface HabitabilityRepairClock {
  dueOn: BusinessDate
  halfwayOn: BusinessDate
  stage: HabitabilityRepairStage
}

/// Null when the state has no configured period - never a guessed one.
export function habitabilityRepairClock(
  openedOn: BusinessDate,
  repairDays: number | null,
  rule: DayCountRule,
  today: BusinessDate,
): HabitabilityRepairClock | null {
  if (repairDays == null) return null
  const dueOn = statutoryDeadline(openedOn, repairDays, rule)
  const halfwayOn = statutoryDeadline(openedOn, Math.floor(repairDays / 2), rule)
  const stage = today > dueOn ? 'OVERDUE' : today >= halfwayOn ? 'HALFWAY' : 'ON_TRACK'
  return { dueOn, halfwayOn, stage }
}
