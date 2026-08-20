import { businessDaysBetween } from '../scheduling/local-time.ts'
import type { BusinessDate } from '../scheduling/local-time.ts'

// Days-to-fill (RPT-01, R-075) - a DIFFERENT clock from `daysOnMarket`
// (`packages/core/units/vacancy.ts`, R-050): that one is OPEN-ENDED ("how
// long has this unit been sitting empty as of TODAY", growing every day a
// unit stays vacant); this one is TERMINAL ("how long did THIS vacancy
// actually last", frozen the moment a new lease moves in). Before this
// item, `getTurnoverForUnit` faked this number by calling `daysOnMarket`
// with its `unitCreatedAt` fallback forced equal to `lastMoveOutAt`
// (neutralizing a branch that does not apply here) and `asOf` set to the
// fill date instead of today - the right number, reached by abusing a
// function built for a different question. This is that number, named and
// tested on its own.

export interface DaysToFillFacts {
  vacatedOn: BusinessDate
  /// When the next lease actually moved in, or null while still vacant.
  filledOn: BusinessDate | null
  /// Today, for a still-vacant unit's running count.
  asOf: BusinessDate
}

export interface DaysToFill {
  days: number
  /// True once a new tenancy has actually started - the count is final and
  /// will not move again. False means it is still counting.
  isFinal: boolean
}

export function daysToFill(facts: DaysToFillFacts): DaysToFill {
  const through = facts.filledOn ?? facts.asOf
  return {
    days: Math.max(0, businessDaysBetween(facts.vacatedOn, through)),
    isFinal: facts.filledOn != null,
  }
}
