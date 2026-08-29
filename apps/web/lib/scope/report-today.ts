import { type BusinessDate, businessDate } from '@rental/core/scheduling'

import type { ResolvedScope } from './types.ts'

/**
 * The calendar day a PORTFOLIO-WIDE report is run on.
 *
 * `complianceToday` answers the mirror question for one obligation and takes
 * the EARLIEST local day - late everywhere before it is called late. A report
 * takes the LATEST, and the two are opposite for the same reason: `to` is an
 * INCLUSIVE end, so the earliest local day silently truncates today's rows for
 * every property east of the westernmost one. The rent roll's filename is the
 * same question wearing a different hat - exported at 20:00 in Houston it was
 * stamped with a UTC tomorrow, and handed to a lender under the wrong date.
 *
 * Zones come from the CURRENT SELECTION rather than everything the actor can
 * see, because that is the set the report actually covers. With nothing
 * selected there is no local clock to read and the report is empty either way,
 * so UTC stands in.
 */
export function reportToday(scope: ResolvedScope, now: Date): BusinessDate {
  const selected = new Set(scope.propertyIds)
  const days = scope.availableProperties
    .filter((property) => selected.has(property.id))
    .map((property) => businessDate(now, property.timezone))
    .sort()
  return days.at(-1) ?? businessDate(now, 'UTC')
}
