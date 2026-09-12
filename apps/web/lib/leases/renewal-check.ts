import 'server-only'

import { renewalRentCheck, type RenewalRentDecision } from '@rental/core/leases'
import { UNREVIEWED_DAY_COUNT, businessDateToUtc, type BusinessDate } from '@rental/core/scheduling'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// The database half of the renewal rent-increase guard (LEASE-09, R-065;
// D-4). packages/core/leases/renewal.ts decides; this fetches the one fact
// it needs - the jurisdiction rule - the same split retaliation-check.ts
// gives its own guard.
//
// Calendar days rather than instants since R-200 - see
// `noticePeriodCheckFor`'s own note on why the conversion belongs to the
// caller.

export async function renewalRentCheckFor(args: {
  propertyState: string
  propertyCounty: string | null
  currentRentCents: number
  proposedRentCents: number
  effectiveOn: BusinessDate
  offeredOn: BusinessDate
}): Promise<RenewalRentDecision> {
  // An unconfigured jurisdiction fails OPEN here, same posture
  // `retaliationCheckFor` takes: a missing rule means neither statutory
  // number is on file, not that the offer should be refused outright over a
  // gap in this product's own configuration.
  const rule = await rulesFor(
    { state: args.propertyState, county: args.propertyCounty },
    businessDateToUtc(args.offeredOn),
  ).catch(() => null)

  return renewalRentCheck({
    currentRentCents: args.currentRentCents,
    proposedRentCents: args.proposedRentCents,
    effectiveOn: args.effectiveOn,
    offeredOn: args.offeredOn,
    rentIncreaseCapPercentBps: rule?.rentIncreaseCapPercentBps ?? null,
    rentIncreaseNoticeDays: rule?.rentIncreaseNoticeDays ?? null,
    dayCount: rule ?? UNREVIEWED_DAY_COUNT,
  })
}
