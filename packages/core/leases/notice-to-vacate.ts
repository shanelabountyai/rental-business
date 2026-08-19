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

interface Violation {
  field: string
  message: string
}

export type NoticePeriodBasis = 'within_limits' | 'insufficient_notice'

export interface NoticePeriodCheckInput {
  /// When notice was (or is being) given - `new Date()` in the ordinary
  /// case, or a stated `givenOn` for a backdated record.
  givenOn: Date
  /// When the tenancy will actually end.
  effectiveOn: Date
  /// JurisdictionRule.noticeToVacateDays. Null means not configured, and the
  /// check is silent rather than guessing - the same posture every other
  /// nullable jurisdiction number takes in this product.
  noticeToVacateDays: number | null
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
}

export function noticePeriodCheck(input: NoticePeriodCheckInput): NoticePeriodDecision {
  const msPerDay = 24 * 60 * 60 * 1000
  const daysGiven = Math.floor((input.effectiveOn.getTime() - input.givenOn.getTime()) / msPerDay)

  if (input.noticeToVacateDays == null) {
    return { basis: 'within_limits', needsOverride: false, daysGiven }
  }
  if (daysGiven < input.noticeToVacateDays) {
    return {
      basis: 'insufficient_notice',
      needsOverride: true,
      daysGiven,
      requiredDays: input.noticeToVacateDays,
      shortfallDays: input.noticeToVacateDays - daysGiven,
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
  /// Property-local, for rendering the date in the tenant's own time (D-3).
  timezone: string
  effectiveOn: Date
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
  const date = formatDate(context.effectiveOn, context.timezone)

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

function formatDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(instant)
}
