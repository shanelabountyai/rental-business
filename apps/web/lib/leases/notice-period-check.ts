import 'server-only'

import { noticePeriodCheck, type NoticePeriodDecision } from '@rental/core/leases'
import { UNREVIEWED_DAY_COUNT, businessDateToUtc, type BusinessDate } from '@rental/core/scheduling'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// The database half of the notice-period guard (LEASE-11, R-066; D-4).
// packages/core/leases/notice-to-vacate.ts decides; this fetches the one
// fact it needs - the jurisdiction rule - the same split retaliation-check.ts
// and renewal-check.ts each give their own guard.
//
// TAKES CALENDAR DAYS, NOT INSTANTS (R-200). The caller knows which reader
// each of its values needs - `utcToBusinessDate` for a `@db.Date` form value,
// `businessDate(now, zone)` for "today" - and this cannot know, which is
// exactly how the portal came to compare a mid-afternoon instant against a
// UTC-midnight date and report a day less notice than the tenant gave.

export async function noticePeriodCheckFor(args: {
  propertyState: string
  propertyCounty: string | null
  givenOn: BusinessDate
  effectiveOn: BusinessDate
}): Promise<NoticePeriodDecision> {
  // An unconfigured jurisdiction fails OPEN, same posture
  // `retaliationCheckFor`/`renewalRentCheckFor` both take: a missing rule
  // means the number simply is not on file, not that the notice should be
  // refused over a gap in this product's own configuration.
  //
  // Effective-dated on the DAY notice was given rather than on the instant
  // this runs: which version of a statute governs a notice is a question
  // about the day it was served.
  const rule = await rulesFor(
    { state: args.propertyState, county: args.propertyCounty },
    businessDateToUtc(args.givenOn),
  ).catch(() => null)

  return noticePeriodCheck({
    givenOn: args.givenOn,
    effectiveOn: args.effectiveOn,
    noticeToVacateDays: rule?.noticeToVacateDays ?? null,
    dayCount: rule ?? UNREVIEWED_DAY_COUNT,
  })
}
