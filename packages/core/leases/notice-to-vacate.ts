// Notice to vacate + non-renewal (LEASE-11, RISK-06, R-066; D-4).
//
// Two facts, one column pair on Lease (noticeGivenAt/noticeGivenBy), and one
// check shared by both directions: is there enough time between when notice
// was given and when the tenancy actually ends? JurisdictionRule.
// noticeToVacateDays is the same number whichever party gives notice - a
// tenant ending a month-to-month tenancy and an owner declining to renew one
// are both "how much warning does this jurisdiction require before a
// periodic tenancy ends", not two different statutory questions (ponytail:
// a state that genuinely splits the two numbers is a second JurisdictionRule
// field away, once one is found - nothing here assumes they can never
// differ, it just has no reason to model a distinction nobody has asked
// for).
//
// Same warn-and-override shape R-027's entry notice, R-055's retaliation
// guard and R-065's renewal notice-period check already establish: a short
// notice period is a timing problem, not a ceiling, so it warns and records
// a reason rather than blocking outright.

import {
  type DayCountRule,
  statutoryDaysBetween,
  statutoryDeadline,
} from '../scheduling/deadline.ts'
import { businessDateToUtc, type BusinessDate } from '../scheduling/local-time.ts'

interface Violation {
  field: string
  message: string
}

export type NoticePeriodBasis = 'within_limits' | 'insufficient_notice'

export interface NoticePeriodCheckInput {
  /// The property-local day notice was (or is being) given. A CALENDAR DAY,
  /// not an instant (R-200): the caller reads it with `utcToBusinessDate`
  /// for a `@db.Date` form value or `businessDate(now, zone)` for "today",
  /// because those are different readers and mixing them is R-042's bug.
  givenOn: BusinessDate
  /// The property-local day the tenancy will actually end.
  effectiveOn: BusinessDate
  /// JurisdictionRule.noticeToVacateDays. Null means not configured, and the
  /// check is silent rather than guessing - the same posture every other
  /// nullable jurisdiction number takes in this product.
  noticeToVacateDays: number | null
  /// How this jurisdiction counts statutory days (R-182/R-200). REQUIRED, not
  /// defaulted, for the reason `cureClock` gives at length: a default would
  /// be this product deciding for itself that a state counts calendar days,
  /// which is the assumption this exists to remove.
  dayCount: DayCountRule
}

export interface NoticePeriodDecision {
  basis: NoticePeriodBasis
  /// True only when the period is short - staff (or a tenant informed of
  /// the gap) may proceed; a stated reason is required only on the STAFF
  /// side (the tenant's own notice needs no business justification for
  /// their own choice - see notice-to-vacate.test.ts's own framing).
  needsOverride: boolean
  daysGiven: number
  requiredDays?: number
  shortfallDays?: number
  /// The earliest day the tenancy could lawfully end on this notice - the
  /// number an operator can actually act on, where a shortfall count only
  /// tells them the date they picked was wrong. Present only on a shortfall.
  earliestOn?: BusinessDate
}

/**
 * Whether enough statutory days sit between the notice and the end of the
 * tenancy.
 *
 * ==========================================================================
 * DECIDES ON A DATE, REPORTS IN DAYS (R-200, review finding 14).
 *
 * Until R-200 this subtracted two timestamps and divided by 86,400,000, so it
 * counted calendar days whatever `dayCountBasis` said - and it is not a
 * deadline being a day out, it is the `needsOverride` flag a PM ticks past.
 * In a business-day state it waved through a notice that was actually short
 * and demanded an override for one that was fine, which teaches an operator
 * that the check is noise.
 *
 * The decision is `effectiveOn < statutoryDeadline(givenOn, required)` - the
 * one function that knows how a legislature counts, asked forwards, which is
 * the direction it can answer. `statutoryDaysBetween` supplies the numbers
 * for the sentence, never the verdict: a count can disagree with the deadline
 * by the roll on a zero-day period, a date comparison cannot.
 *
 * ON `CALENDAR_ROLL_FORWARD` THIS NOW WARNS WHERE IT DID NOT, and that is a
 * deliberate reading rather than an accident. A roll-forward statute extends
 * the period to the next working day; the party protected by a notice period
 * is the one RECEIVING it, so the extension means the tenancy cannot end
 * before that day. The alternative reading - that roll-forward governs only
 * deadlines to act and not periods of warning - is also defensible, and if a
 * state turns out to mean it, this is the line to change. Erring toward
 * flagging is the right asymmetry for a check that only ever WARNS: a
 * spurious warning costs an override click and a stated reason, a missed one
 * ships a short notice.
 *
 * On `CALENDAR` and on an unreviewed rule every branch reduces to exactly the
 * arithmetic above it did before - same verdict, same `daysGiven`, same
 * `shortfallDays` - so no state on file today moves (D-193, D-12).
 * ==========================================================================
 */
export function noticePeriodCheck(input: NoticePeriodCheckInput): NoticePeriodDecision {
  const daysGiven = statutoryDaysBetween(input.givenOn, input.effectiveOn, input.dayCount)

  if (input.noticeToVacateDays == null) {
    return { basis: 'within_limits', needsOverride: false, daysGiven }
  }

  const earliestOn = statutoryDeadline(input.givenOn, input.noticeToVacateDays, input.dayCount)
  if (input.effectiveOn < earliestOn) {
    return {
      basis: 'insufficient_notice',
      needsOverride: true,
      daysGiven,
      requiredDays: input.noticeToVacateDays,
      shortfallDays: statutoryDaysBetween(input.effectiveOn, earliestOn, input.dayCount),
      earliestOn,
    }
  }
  return { basis: 'within_limits', needsOverride: false, daysGiven }
}

/**
 * Same shape as `validateRetaliationAck`/`validateRenewalOverride`: a reason
 * typed where none was needed is harmless, but a missing one where the
 * check demanded it leaves a short-notice non-renewal with no defence on
 * the record.
 */
export function validateNoticePeriodOverride(reason: string | null | undefined): Violation[] {
  if (!reason?.trim()) {
    return [
      {
        field: 'overrideReason',
        message:
          "This is short of the jurisdiction's required notice period. State why - it is recorded.",
      },
    ]
  }
  return []
}

/**
 * Same shape as `validateRetaliationAck`: a jurisdiction that requires a
 * stated just cause for non-renewal (JurisdictionRule.justCauseRequired)
 * gets one, in the owner's own words - never a canned list of causes this
 * product picks for them. D-4's own line applies here in full: enumerating
 * which reasons legally qualify as "just cause" in a given state is legal
 * advice this product does not give; requiring the reason be WRITTEN DOWN
 * is not.
 */
export function validateJustCauseStatement(
  required: boolean,
  statement: string | null | undefined,
): Violation[] {
  if (required && !statement?.trim()) {
    return [
      {
        field: 'justCauseStatement',
        message: 'This jurisdiction requires a stated cause for non-renewal.',
      },
    ]
  }
  return []
}

export interface NonRenewalNoticeContext {
  tenantName: string
  addressLine1: string
  unitName: string
  /// The day the tenancy ends, as a calendar day. NOT an instant and NOT
  /// accompanied by a timezone - see `formatDate` below for the defect that
  /// cost.
  effectiveOn: BusinessDate
  justCauseStatement: string | null
  /// Shown as an informational statement when configured - the same
  /// "your jurisdiction requires..." line entryNoticeText() gives.
  noticeToVacateDays: number | null
}

/**
 * The non-renewal notice text itself.
 *
 * A DRAFT, same posture as every other generated legal artifact in this
 * product (D-4's closing line) - not reviewed by counsel, and it says so in
 * its own last line.
 */
export function nonRenewalNoticeText(context: NonRenewalNoticeContext): string {
  const date = formatDate(context.effectiveOn)

  return [
    `Notice of non-renewal`,
    '',
    `Dear ${context.tenantName},`,
    '',
    `This is written notice that your tenancy at ${context.addressLine1}${
      context.unitName ? ` (${context.unitName})` : ''
    } will not be renewed and will end on ${date}.`,
    '',
    context.justCauseStatement ? `Reason for non-renewal: ${context.justCauseStatement}` : null,
    context.noticeToVacateDays != null
      ? `Your jurisdiction requires at least ${context.noticeToVacateDays} days' notice before a periodic tenancy ends; this notice provides that.`
      : null,
    '',
    'Please contact us with any questions, and to arrange a move-out inspection.',
    '',
    '— This notice is a draft generated by the property management system and has not been reviewed by an attorney. It is not legal advice.',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

/**
 * The end-of-tenancy date, in the long form a served notice should carry.
 *
 * ==========================================================================
 * `timeZone: 'UTC'`, AND IT IS LOAD-BEARING (R-200).
 *
 * This took `effectiveOn` as a `Date` and a property timezone and formatted
 * one through the other. `effectiveOn` is a calendar day - it arrives from
 * `parseLeaseDate`, which builds UTC midnight - so putting it through
 * `America/Chicago` moved it a day west: a tenancy ending 1 October was
 * SERVED ON THE TENANT as ending "Wednesday, September 30, 2026". The wrong
 * date, in the operative sentence, of an outbound legal document, for every
 * property in the deployment.
 *
 * Exactly the R-042 defect CLAUDE.md names: a calendar day must never be
 * converted through a timezone, and the timezone parameter LOOKED like the
 * careful thing to do. Taking a `BusinessDate` is what stops it coming back -
 * there is no longer an instant here for a zone to move.
 *
 * Formatted rather than handed to `friendlyBusinessDate` because a notice
 * wants the weekday and the full month ("Thursday, October 1, 2026"), which
 * that helper deliberately does not render.
 * ==========================================================================
 */
function formatDate(date: BusinessDate): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(businessDateToUtc(date))
}
