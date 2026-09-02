// What remains of the comparison module: the fixable-list predicate the
// turnover punch list reads. The side-by-side comparison itself is R-070's
// screen, driven by the `InspectionItem.moveInItemId` FK - a `conditionChange`
// delta helper lived here awaiting a screen that turned out to already exist,
// and R-151 deleted it.

import { type ItemConditionValue } from './validate.ts'

/// POOR or worse - the "itemized fixable list" INSP-02 asks the
/// pre-move-out walkthrough to produce: what a tenant could still put right
/// before the real move-out inspection happens.
const FIXABLE_CONDITIONS = new Set<ItemConditionValue>(['POOR', 'DAMAGED', 'MISSING'])

export function isFixableCondition(condition: string | null): boolean {
  return condition != null && FIXABLE_CONDITIONS.has(condition as ItemConditionValue)
}
