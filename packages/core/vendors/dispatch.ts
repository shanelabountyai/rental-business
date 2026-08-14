// Vendor selection and the no-response timer (MAINT-03, R-025).
//
// "Given no vendor response in X hours (config), when the timer lapses, then
// the PM is prompted to re-dispatch to the next vendor on the trade's
// fallback list."
//
// Two halves, both pure: who is next for a trade, and whether the current
// dispatch has gone quiet long enough to say so.

export const VENDOR_RESPONSES = ['ACCEPTED', 'DECLINED', 'PROPOSED_TIME'] as const
export type VendorResponseValue = (typeof VENDOR_RESPONSES)[number]

export function isVendorResponse(value: string): value is VendorResponseValue {
  return (VENDOR_RESPONSES as readonly string[]).includes(value)
}

/**
 * How long silence has to last before the PM is told (MAINT-03's "X hours,
 * config").
 *
 * ponytail: one constant, not a per-property JurisdictionRule or an operator
 * setting. This is a business-convenience threshold, not a
 * jurisdiction-dependent number - D-4's "never hardcode" rule is about
 * things a statute can change (grace periods, fee caps, notice hours), and
 * no statute anywhere says how long a landlord waits on a plumber. Promote
 * it to configuration the first time an operator actually wants a different
 * number, not before.
 *
 * Emergency work orders get a much shorter fuse for the obvious reason.
 */
export const NO_RESPONSE_HOURS = { EMERGENCY: 2, URGENT: 8, ROUTINE: 24 } as const

export function noResponseHoursFor(priority: string): number {
  return (
    NO_RESPONSE_HOURS[priority as keyof typeof NO_RESPONSE_HOURS] ??
    NO_RESPONSE_HOURS.ROUTINE
  )
}

/**
 * How long a vendor's magic link lives, by the job's priority (R-032d, D-16).
 *
 * D-16 fixed one number — three days — and it was tuned for a same-week job.
 * Routine work is booked out a week and the link was dead before the vendor
 * arrived; the fallback was "call the office and we will send a new one",
 * which is the phoned-in re-keying D-6 exists to prevent.
 *
 * EMERGENCY AND URGENT STAY SHORT DELIBERATELY. They are attended within
 * hours, so a long-lived credential buys nothing and lingers — and the link
 * can reveal an access code. The lifetime tracks how long the job is
 * plausibly live, which is the honest basis for expiring a credential.
 *
 * Fourteen days for routine covers "booked next Tuesday" with slack. It does
 * NOT cover a month-end invoice, and it deliberately is not stretched to:
 * that tail is what `reissueOnExpiry` handles, without weakening the control
 * for every link in the product.
 */
export const LINK_TTL_DAYS = { EMERGENCY: 3, URGENT: 3, ROUTINE: 14 } as const

export function linkTtlMinutesFor(priority: string): number {
  const days =
    LINK_TTL_DAYS[priority as keyof typeof LINK_TTL_DAYS] ?? LINK_TTL_DAYS.ROUTINE
  return days * 24 * 60
}

export interface DispatchState {
  priority: string
  dispatchedAt: Date | null
  vendorRespondedAt: Date | null
}

/**
 * Whether a dispatched work order has gone unanswered past its threshold.
 *
 * Never dispatched → false, not "overdue since the beginning of time": a
 * work order nobody has sent anywhere is a PM's own to-do, not a silent
 * vendor, and reporting it here would bury the real ones.
 */
export function vendorHasNotResponded(state: DispatchState, now: Date): boolean {
  if (!state.dispatchedAt) return false
  if (state.vendorRespondedAt) return false
  const elapsedHours = (now.getTime() - state.dispatchedAt.getTime()) / 3_600_000
  return elapsedHours >= noResponseHoursFor(state.priority)
}

export interface VendorCandidate {
  id: string
  name: string
  trades: readonly string[]
  /// Lower sorts first. Null = no stated preference, and sorts after every
  /// vendor who has one.
  preferredRank: number | null
  active: boolean
  w9OnFile: boolean
  coiExpiresOn: Date | null
}

export interface RankedVendor extends VendorCandidate {
  /// Surfaced rather than filtered on. MAINT-11 blocks or flags PAYMENT
  /// without a W-9 - it does not forbid dispatching the only plumber who
  /// answers at 2am. A PM seeing "no W-9 on file" before they send is the
  /// point; silently hiding that vendor would leave them wondering why the
  /// list is short.
  w9Missing: boolean
  coiExpired: boolean
}

/**
 * The fallback list for a trade: active vendors who work that trade, best
 * first.
 *
 * `excludeVendorIds` is how re-dispatch skips whoever already declined or
 * went silent - the PM asking for "the next vendor" means next, not the same
 * one again.
 */
export function fallbackVendorsForTrade(
  vendors: readonly VendorCandidate[],
  trade: string,
  now: Date,
  excludeVendorIds: readonly string[] = [],
): RankedVendor[] {
  const excluded = new Set(excludeVendorIds)
  return vendors
    .filter((v) => v.active && !excluded.has(v.id) && v.trades.includes(trade))
    .map((v) => ({
      ...v,
      w9Missing: !v.w9OnFile,
      coiExpired: v.coiExpiresOn != null && v.coiExpiresOn < now,
    }))
    .sort((a, b) => {
      const rankA = a.preferredRank ?? Number.MAX_SAFE_INTEGER
      const rankB = b.preferredRank ?? Number.MAX_SAFE_INTEGER
      if (rankA !== rankB) return rankA - rankB
      // Stable, readable tiebreak - two vendors both unranked should not
      // come back in whatever order the database happened to return.
      return a.name.localeCompare(b.name)
    })
}
