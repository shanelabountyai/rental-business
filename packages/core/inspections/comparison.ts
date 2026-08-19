// The move-in/move-out comparison itself (INSP-02, R-070). Pure - the
// pairing of WHICH move-out item goes beside which move-in item is a real
// foreign key on the schema (`InspectionItem.moveInItemId`), not something
// computed here; this only reads condition ranks once a pair is already in
// hand.

import { ITEM_CONDITIONS, type ItemConditionValue } from './validate.ts'

/// Best to worst, matching `ITEM_CONDITIONS`' own declared order - the
/// vocabulary already encodes the ranking, so this reads it rather than
/// re-declaring a second ordering that could drift from the first.
const CONDITION_RANK: Readonly<Record<ItemConditionValue, number>> = Object.fromEntries(
  ITEM_CONDITIONS.map((condition, index) => [condition, index]),
) as Record<ItemConditionValue, number>

export type ConditionChange = 'improved' | 'same' | 'declined' | 'unknown'

/**
 * How a paired item's condition moved between the two walks. `'unknown'`
 * when either side has not been walked yet (a fresh move-out item before
 * anyone records its condition, or a move-in with none on file) - never
 * guessed as `'same'`, which would hide a real gap in the evidence.
 */
export function conditionChange(
  moveIn: string | null,
  moveOut: string | null,
): ConditionChange {
  if (moveIn == null || moveOut == null) return 'unknown'
  if (!(moveIn in CONDITION_RANK) || !(moveOut in CONDITION_RANK)) return 'unknown'
  const delta = CONDITION_RANK[moveOut as ItemConditionValue] - CONDITION_RANK[moveIn as ItemConditionValue]
  if (delta === 0) return 'same'
  return delta > 0 ? 'declined' : 'improved'
}

/// POOR or worse - the "itemized fixable list" INSP-02 asks the
/// pre-move-out walkthrough to produce: what a tenant could still put right
/// before the real move-out inspection happens.
const FIXABLE_CONDITIONS = new Set<ItemConditionValue>(['POOR', 'DAMAGED', 'MISSING'])

export function isFixableCondition(condition: string | null): boolean {
  return condition != null && FIXABLE_CONDITIONS.has(condition as ItemConditionValue)
}
