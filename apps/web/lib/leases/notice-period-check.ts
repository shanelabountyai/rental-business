import 'server-only'

import { noticePeriodCheck, type NoticePeriodDecision } from '@rental/core/leases'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// The database half of the notice-period guard (LEASE-11, R-066; D-4).
// packages/core/leases/notice-to-vacate.ts decides; this fetches the one
// fact it needs - the jurisdiction rule - the same split retaliation-check.ts
// and renewal-check.ts each give their own guard.

export async function noticePeriodCheckFor(args: {
  propertyState: string
  propertyCounty: string | null
  givenOn: Date
  effectiveOn: Date
}): Promise<NoticePeriodDecision> {
  // An unconfigured jurisdiction fails OPEN, same posture
  // `retaliationCheckFor`/`renewalRentCheckFor` both take: a missing rule
  // means the number simply is not on file, not that the notice should be
  // refused over a gap in this product's own configuration.
  const rule = await rulesFor(
    { state: args.propertyState, county: args.propertyCounty },
    args.givenOn,
  ).catch(() => null)

  return noticePeriodCheck({
    givenOn: args.givenOn,
    effectiveOn: args.effectiveOn,
    noticeToVacateDays: rule?.noticeToVacateDays ?? null,
  })
}
