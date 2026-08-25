// "Defective service restarts everything" (PAY-14, R-083).
//
// THIS FILE COMPUTES NOTHING NEW ABOUT SERVICE. R-051 already decided, at the
// moment of service, whether the method used was one the state names for this
// notice type, and STORED that verdict on the delivery row
// (`NoticeDelivery.permittedByJurisdiction`, D-48) precisely so it is never
// recomputed against rules that may have changed since (D-4: rules apply
// prospectively). What happens here is the consequence nobody had drawn yet:
// a cure period runs from a service that was actually good, and a case whose
// only service was defective has no clock running at all.

import { addBusinessDays, type BusinessDate } from '../scheduling/local-time.ts'

/**
 * The notice types that can start a cure period, and so the types an eviction
 * case will accept (D-148).
 *
 * ONE LIST, READ BY BOTH SIDES, and that is the whole reason it is here
 * rather than inline. `attachableNotices` offered a type the cure clock then
 * ignored, so a case could be handed a served notice and still report
 * "Notice not yet served" - on the same screen showing the notice. The demo
 * walk found it holding exactly the notice Texas actually uses.
 *
 * `NOTICE_TO_VACATE` is on this list because Tex. Prop. Code 24.005 names the
 * non-payment instrument that way: there is no separate "pay or quit" to
 * serve in this product's own default jurisdiction, and the TX rule already
 * models 24.005's three days as `payOrQuitDays`. An operator picking the type
 * their statute names must not dead-end.
 *
 * It costs nothing where both types exist. The clock runs from the EARLIEST
 * good service, so in a state that serves pay-or-quit first and a notice to
 * vacate after the cure period lapses, the earlier PAY_OR_QUIT still sets the
 * date and the later notice cannot move it.
 */
export const CURE_NOTICE_TYPES: readonly string[] = ['PAY_OR_QUIT', 'NOTICE_TO_VACATE']

/**
 * One recorded service event, as R-051 stored it.
 *
 * `permittedByJurisdiction` is THREE-VALUED and the middle value is the whole
 * point (D-48):
 *   true  - the state names this method for this notice type
 *   false - it does not, and this service is defective
 *   null  - NOBODY HAS TOLD US, which is not the same as "no"
 *
 * A null is treated as good service here, deliberately. The alternative -
 * refusing to start a clock because this product has not been taught a
 * state's service rules - would invent a defect the law never asserted, and
 * would do it silently, on the owner's own evidence. R-044 makes the same
 * call for an unknown grace period and R-051 makes it for recording the
 * service at all.
 */
export interface ServiceEvent {
  servedOn: BusinessDate
  permittedByJurisdiction: boolean | null
}

export type CureClockState =
  /// The notice exists but nothing has been served yet.
  | 'not_served'
  /// Everything served was served a way the state does not name. No clock is
  /// running - this is the "restarts everything" case.
  | 'defective_service'
  /// Served, and the tenant still has time.
  | 'running'
  /// Served, and the period has run out.
  | 'expired'

export interface CureClock {
  state: CureClockState
  /// The service the clock runs from - the EARLIEST good one, not the latest.
  /// A landlord who served badly on Monday and correctly on Wednesday has a
  /// clock that started Wednesday; one who served correctly on Monday and
  /// again on Wednesday does not get to restart it by re-serving.
  runsFrom: BusinessDate | null
  /// Last day the tenant may cure. Null whenever no clock is running, and
  /// null ALSO when the jurisdiction has no `payOrQuitDays` configured -
  /// see `cureClock`'s own note.
  cureBy: BusinessDate | null
  /// True only when this product does not know the state's cure period. The
  /// caller shows "not configured", never a guessed number of days.
  periodUnknown: boolean
}

/**
 * Where the cure period stands, given every service recorded for the notice.
 *
 * `payOrQuitDays` null means this product has not been taught the state's
 * cure period. The clock is then reported as running with NO deadline rather
 * than as expired: a deadline this product invented is the one number in an
 * eviction file that must never be guessed, because acting a day early is
 * what gets a case dismissed and the whole thing started over.
 */
export function cureClock(
  services: readonly ServiceEvent[],
  payOrQuitDays: number | null,
  today: BusinessDate,
): CureClock {
  const periodUnknown = payOrQuitDays == null

  if (services.length === 0) {
    return { state: 'not_served', runsFrom: null, cureBy: null, periodUnknown }
  }

  const good = services.filter((s) => s.permittedByJurisdiction !== false)
  if (good.length === 0) {
    return { state: 'defective_service', runsFrom: null, cureBy: null, periodUnknown }
  }

  const runsFrom = good.reduce((earliest, s) => (s.servedOn < earliest ? s.servedOn : earliest), good[0]!.servedOn)

  if (periodUnknown) {
    return { state: 'running', runsFrom, cureBy: null, periodUnknown }
  }

  const cureBy = addBusinessDays(runsFrom, payOrQuitDays)
  return {
    state: today > cureBy ? 'expired' : 'running',
    runsFrom,
    cureBy,
    periodUnknown,
  }
}

export const CURE_STATE_LABELS: Record<CureClockState, string> = {
  not_served: 'Notice not yet served — no cure period is running',
  defective_service:
    'Every recorded service used a method this state does not name for this notice. No cure period is running, and serving again starts it from that later date.',
  running: 'Cure period running',
  expired: 'Cure period expired',
}

export type FilingRefusal = 'no_case_notice' | 'not_served' | 'defective_service' | 'still_curing'

export interface FilingReadiness {
  ready: boolean
  refusal?: FilingRefusal
}

/**
 * Whether the case may move from NOTICE to FILING.
 *
 * This is the one place the product actively stops a PM, and it stops them
 * from the single most expensive mistake in the whole path: filing before the
 * cure period has run, or on a service the state does not recognise. Either
 * gets the case thrown out, and by then the tenant has lived rent-free for
 * another month and everything starts again.
 *
 * An unknown cure period (`periodUnknown`) does NOT block filing - this
 * product refusing to let an owner proceed because IT has not been taught
 * Ohio's rules would be substituting its own ignorance for their attorney's
 * advice. The case file says the period is unconfigured and the decision
 * stays with the human, which is the same line `servicePermitted()` draws.
 */
export function readyToFile(clock: CureClock, hasNotice: boolean): FilingReadiness {
  if (!hasNotice) return { ready: false, refusal: 'no_case_notice' }
  if (clock.state === 'not_served') return { ready: false, refusal: 'not_served' }
  if (clock.state === 'defective_service') return { ready: false, refusal: 'defective_service' }
  if (clock.state === 'running' && !clock.periodUnknown) {
    return { ready: false, refusal: 'still_curing' }
  }
  return { ready: true }
}

export const FILING_REFUSAL_MESSAGES: Record<FilingRefusal, string> = {
  no_case_notice: 'Attach the served notice to this case before recording a filing.',
  not_served: 'The notice has not been served yet. Record the service and its proof first.',
  defective_service:
    'Every recorded service used a method this state does not name for this notice. Serve again by a method it does name — filing on defective service is how a case gets dismissed and started over.',
  still_curing:
    'The cure period has not run out yet. Filing early is the most common reason these cases are dismissed.',
}
