// The turn as a SEQUENCED PROJECT rather than a bag of loose work orders
// (LEASE-12, RPT-05; R-178, review §10).
//
// R-072 gave a turn a unit, a lease, a target date and a pile of
// `WorkOrder`s with `turnoverStage` mostly null. Nothing said what order the
// stages run in, when each one is due, which one the next is waiting on, or
// that a turn has not moved in a week - so "the floor guy cannot start
// because the paint is not done, and nobody notices for six days" was
// invisible on every screen in this product.
//
// EVERYTHING HERE IS DERIVED. There is no `TurnoverStageTarget` table and no
// per-stage columns, because there is nothing to store that the work orders
// and `targetRentReadyDate` do not already say - and a stored per-stage due
// date would go stale the moment somebody moved the target, which is the
// commonest edit on this panel. Same posture `TurnoverProject` itself takes
// on status (its own schema comment: null vs. set on `rentReadyAt` IS the
// status, so there is nothing for a second field to disagree with).

import type { TurnoverStage, WorkOrderStatus } from '@rental/db'
import {
  addBusinessDays,
  type BusinessDate,
  businessDaysBetween,
} from '../scheduling/local-time.ts'
import { TURNOVER_STAGE_LABELS } from './stages.ts'

/**
 * The stages that actually run in sequence, in order. `TURNOVER_STAGES`'
 * seventh value `OTHER` is deliberately NOT here: it is the escape hatch for
 * a line that belongs to no stage, so it has no position, no day budget and
 * nothing waits on it.
 */
export const TURN_SEQUENCE = [
  'TRASH_OUT',
  'REPAIRS',
  'PAINT',
  'FLOORS',
  'CLEAN',
  'REKEY',
] as const satisfies readonly TurnoverStage[]
export type SequencedStage = (typeof TURN_SEQUENCE)[number]

const SEQUENCE_INDEX: Record<string, number> = Object.fromEntries(
  TURN_SEQUENCE.map((stage, index) => [stage, index]),
)

/**
 * A HOUSE HEURISTIC, not a statute and not a `JurisdictionRule` - nothing
 * about how long paint takes is legal, so D-4's "never hardcode a legal
 * number" does not reach here, and the same posture
 * `ABANDONMENT_QUIET_STALL_DAYS` and `WATER_MITIGATION_TARGET_HOURS` already
 * state about themselves applies: a plausible standard turn, sized so the
 * schedule is a useful default rather than a promise.
 *
 * 13 days end to end for a normal single-family turn. Repairs is the long
 * pole and the one that actually varies; the rest are a day or three of
 * somebody else's crew.
 */
export const TURN_STAGE_DAYS: Record<SequencedStage, number> = {
  TRASH_OUT: 1,
  REPAIRS: 5,
  PAINT: 3,
  FLOORS: 2,
  CLEAN: 1,
  REKEY: 1,
}

/**
 * "The physical work happened" - NOT the same question as
 * `OPEN_WORK_ORDER_STATUSES`' "is there still work to do here", which counts
 * WORK_COMPLETE and VERIFIED as open because somebody still has to pay the
 * vendor.
 *
 * The floor guy can start when the paint is DONE, not when the painter has
 * been PAID, so sequencing reads this set. It is R-176's own
 * `REKEY_DONE_STATUSES`, lifted out of `apps/web/lib/turnover/actions.ts`
 * where it was a private const with one reader: this file is the second
 * reader and `currentStageFor` in `lib/reports/queries.ts` was a third
 * copy that disagreed with it (it omitted WORK_COMPLETE and VERIFIED, so a
 * stage whose work was finished still read as the stage currently being
 * worked). One definition, three readers - R-036b's lesson is that a
 * status's meaning has to live where every list that reads it can see it.
 *
 * CANCELED is not here and must not be: a canceled line is not work that
 * happened. It is handled by `stageWorkIsOpen` below, which treats it as nothing
 * left to wait for - which is the point of canceling a stage this turn does
 * not need.
 */
export const WORK_PERFORMED_STATUSES = [
  'WORK_COMPLETE',
  'VERIFIED',
  'INVOICED',
  'CLOSED',
] as const satisfies readonly WorkOrderStatus[]

const PERFORMED = new Set<string>(WORK_PERFORMED_STATUSES)

/// Still holding the stage up. Anything not performed and not canceled.
export function stageWorkIsOpen(status: string): boolean {
  return status !== 'CANCELED' && !PERFORMED.has(status)
}

/**
 * How long a turn may sit with nothing moving before it is a case somebody
 * has to look at. A house number, like the four other stall thresholds in
 * `case-stall-job.ts` - review §10 names six days as the cost it saw, so
 * this fires on the sixth.
 */
export const TURN_STALL_DAYS = 6

export type StageState = 'EMPTY' | 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE'

export interface StagePlan {
  stage: SequencedStage
  label: string
  /// The first day this stage is expected to run, and the day it is due -
  /// laid forward from the move-out, one stage after another, at
  /// `TURN_STAGE_DAYS`.
  startsOn: BusinessDate
  dueOn: BusinessDate
  itemCount: number
  openCount: number
  state: StageState
  /**
   * The earliest EARLIER stage that still has open work - what this stage is
   * waiting on, and the whole point of the item. Null when nothing earlier is
   * outstanding, when this stage has no open work of its own (a stage nobody
   * has started is not blocked, it is simply not its turn), and always for
   * REKEY (see `SEQUENCE_EXEMPT`).
   */
  waitingOn: SequencedStage | null
  /// Past `dueOn` with work still open.
  overdue: boolean
}

export interface TurnPlan {
  stages: StagePlan[]
  /// Where the plan lands if every budget above holds: the last stage's
  /// `dueOn`.
  projectedRentReadyOn: BusinessDate
  /**
   * Days by which the plan overruns `targetRentReadyDate`. Null when no
   * target is set, and null when the plan fits - a number here means the
   * standard turn does not make the date somebody has committed to, which is
   * a decision to take on the day the turn opens rather than on the day it
   * is missed.
   */
  daysOverTarget: number | null
}

/**
 * REKEY IS EXEMPT FROM THE CHAIN, and this is the one place the sequence and
 * R-176 disagree.
 *
 * Re-key is last in the checklist because the trades need access while the
 * turn runs - you do not change the locks and then hand a new key to four
 * crews. But R-176 opens the re-key work order at URGENT the moment the turn
 * does, on the argument that the departing tenant may still hold a working
 * key, and it gates `markTurnoverRentReady` on it. If the chain applied, a
 * fresh turn's panel would read "Re-key — waiting on Trash-out" beside an
 * URGENT work order saying do this now, which is a screen telling a PM two
 * opposite things.
 *
 * So re-key keeps its day budget (it is still what closes the turn, which is
 * what makes the rent-ready gate the right shape) and waits on nothing.
 */
const SEQUENCE_EXEMPT: ReadonlySet<SequencedStage> = new Set<SequencedStage>(['REKEY'])

export interface TurnPlanInput {
  /// The day the tenancy ended. Stage one starts the day after.
  moveOutDate: BusinessDate
  targetRentReadyDate: BusinessDate | null
  today: BusinessDate
  workOrders: readonly { turnoverStage: string | null; status: string }[]
}

export function planTurn(input: TurnPlanInput): TurnPlan {
  const byStage = new Map<SequencedStage, { itemCount: number; openCount: number; started: boolean }>()
  for (const stage of TURN_SEQUENCE) {
    byStage.set(stage, { itemCount: 0, openCount: 0, started: false })
  }
  for (const workOrder of input.workOrders) {
    const stage = workOrder.turnoverStage
    if (!stage || !(stage in SEQUENCE_INDEX)) continue
    const bucket = byStage.get(stage as SequencedStage)!
    bucket.itemCount++
    if (stageWorkIsOpen(workOrder.status)) bucket.openCount++
    // "Somebody has touched this" - anything past the status a work order is
    // born at. A stage holding nothing but freshly-created template lines is
    // NOT_STARTED, which is the distinction a PM reads the panel for.
    if (workOrder.status !== 'SUBMITTED') bucket.started = true
  }

  const stages: StagePlan[] = []
  let cursor = input.moveOutDate
  for (const stage of TURN_SEQUENCE) {
    const bucket = byStage.get(stage)!
    const startsOn = addBusinessDays(cursor, 1)
    const dueOn = addBusinessDays(startsOn, TURN_STAGE_DAYS[stage] - 1)
    cursor = dueOn

    const state: StageState =
      bucket.itemCount === 0
        ? 'EMPTY'
        : bucket.openCount === 0
          ? 'DONE'
          : bucket.started
            ? 'IN_PROGRESS'
            : 'NOT_STARTED'

    const waitingOn =
      bucket.openCount > 0 && !SEQUENCE_EXEMPT.has(stage)
        ? (TURN_SEQUENCE.slice(0, SEQUENCE_INDEX[stage]).find(
            (earlier) => byStage.get(earlier)!.openCount > 0,
          ) ?? null)
        : null

    stages.push({
      stage,
      label: TURNOVER_STAGE_LABELS[stage],
      startsOn,
      dueOn,
      itemCount: bucket.itemCount,
      openCount: bucket.openCount,
      state,
      waitingOn,
      overdue: state !== 'DONE' && state !== 'EMPTY' && businessDaysBetween(dueOn, input.today) > 0,
    })
  }

  const projectedRentReadyOn = stages[stages.length - 1]!.dueOn
  const over = input.targetRentReadyDate
    ? businessDaysBetween(input.targetRentReadyDate, projectedRentReadyOn)
    : 0

  return {
    stages,
    projectedRentReadyOn,
    daysOverTarget: input.targetRentReadyDate && over > 0 ? over : null,
  }
}
