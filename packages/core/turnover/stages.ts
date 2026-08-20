// The turnover checklist's canonical stages (LEASE-12, R-072). Same
// TYPE-ONLY-import-checked-with-satisfies shape every other closed
// vocabulary in this package takes (see workorders/validate.ts's own
// comment on why a value import of the generated Prisma client would drag
// it into the browser bundle) - `TurnoverStage` here is a type-only import.

import type { TurnoverStage } from '@rental/db'

/// Declared in the order the backlog names the checklist: trash-out first,
/// re-key last. Not a hard sequence anything enforces (see the schema
/// comment on `TurnoverStage`) - just the display order and the "add a
/// stage" quick-picks read from this array.
export const TURNOVER_STAGES = [
  'TRASH_OUT',
  'REPAIRS',
  'PAINT',
  'FLOORS',
  'CLEAN',
  'REKEY',
  'OTHER',
] as const satisfies readonly TurnoverStage[]
export type TurnoverStageValue = (typeof TURNOVER_STAGES)[number]

export const TURNOVER_STAGE_LABELS: Record<TurnoverStageValue, string> = {
  TRASH_OUT: 'Trash-out',
  REPAIRS: 'Repairs',
  PAINT: 'Paint',
  FLOORS: 'Floors',
  CLEAN: 'Clean',
  REKEY: 'Re-key',
  OTHER: 'Other',
}

export function isTurnoverStage(value: string): value is TurnoverStageValue {
  return (TURNOVER_STAGES as readonly string[]).includes(value)
}
