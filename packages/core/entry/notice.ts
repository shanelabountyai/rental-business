// Entry-notice compliance (MAINT-05, COMM-02, RISK, R-027).
//
// MAINT-05: "Given a jurisdiction requiring N-hours entry notice, when staff
// schedule a non-emergency entry sooner, then the system warns and requires
// an override with reason."
//
// THE HOURS ARE NEVER A LITERAL HERE. D-4 is explicit that anything a
// statute can change is versioned, effective-dated configuration -
// `JurisdictionRule.entryNoticeHours`, read through `rulesFor()` - and entry
// notice is the textbook case: Texas says one thing, California another, and
// a city ordinance can say a third. This module takes the number as an
// argument and never guesses one, so there is no code path where a missing
// rule silently becomes "no notice needed".
//
// WHAT THIS FILE IS NOT. It decides whether notice is SUFFICIENT and drafts
// text a human reads before it is sent. It is not legal advice, and the
// drafted notice says so; every legal artifact in this product is a draft
// requiring review (D-4's own closing line).

export type EntryBasis =
  /// An emergency. Every US jurisdiction that requires notice at all carves
  /// out emergencies - you do not wait 24 hours to enter a unit that is
  /// flooding. Recorded as a basis rather than treated as "no rule applied",
  /// because WHY entry was lawful is the question afterwards.
  | 'emergency'
  /// The tenant said come in. MAINT-05's "tenant grants logged
  /// permission-to-enter" - superior to notice, since consent is what notice
  /// exists to substitute for.
  | 'tenant_permission'
  /// Notice was served with enough time before the window opens.
  | 'notice_served'
  /// Notice period not satisfied, and no other basis. Entry may still go
  /// ahead, but only through a logged override.
  | 'insufficient_notice'

export interface EntryFacts {
  /// When the visit is scheduled to START. Notice is measured to the
  /// beginning of the window, not the end - a tenant is entitled to the full
  /// period before anyone may arrive.
  scheduledStart: Date
  /// When the notice was (or would be) served. Usually now.
  noticeServedAt: Date | null
  /// From JurisdictionRule, via rulesFor(). Null means the jurisdiction on
  /// file states no entry-notice period.
  entryNoticeHours: number | null
  isEmergency: boolean
  tenantPermissionGrantedAt: Date | null
}

export interface EntryDecision {
  basis: EntryBasis
  /// True when staff may proceed without an override.
  permitted: boolean
  /// How many hours short, when insufficient. Shown to whoever is deciding
  /// whether to override, because "you are two hours short" and "you are
  /// twenty-two hours short" are different decisions.
  shortfallHours?: number
  requiredHours?: number
}

/**
 * Whether this entry may go ahead as scheduled.
 *
 * Order matters and is not arbitrary. Emergency first: a gas leak does not
 * become lawful-to-enter only after checking whether a notice was mailed.
 * Then tenant permission, because consent outranks the substitute for
 * consent. Only then the clock.
 *
 * `permitted: false` is NOT "refuse" - MAINT-05 asks for warn-and-override,
 * not a block. The caller's job is to make the override deliberate and
 * logged, which is what turns an unlawful entry into a documented judgement
 * call.
 */
export function entryDecision(facts: EntryFacts): EntryDecision {
  if (facts.isEmergency) return { basis: 'emergency', permitted: true }

  // Permission granted BEFORE the visit. A grant recorded after the fact is
  // not consent, it is a story told afterwards - and the comparison is what
  // stops a backdated note being treated as authorization.
  if (
    facts.tenantPermissionGrantedAt != null &&
    facts.tenantPermissionGrantedAt <= facts.scheduledStart
  ) {
    return { basis: 'tenant_permission', permitted: true }
  }

  // No stated period in the jurisdiction on file. Permitted, and labelled as
  // having been served rather than as an exception, because a notice still
  // went out - there is simply no statutory minimum to measure it against.
  if (facts.entryNoticeHours == null) {
    return { basis: 'notice_served', permitted: true }
  }

  if (facts.noticeServedAt == null) {
    return {
      basis: 'insufficient_notice',
      permitted: false,
      requiredHours: facts.entryNoticeHours,
      shortfallHours: facts.entryNoticeHours,
    }
  }

  const hoursOfNotice =
    (facts.scheduledStart.getTime() - facts.noticeServedAt.getTime()) / 3_600_000

  if (hoursOfNotice >= facts.entryNoticeHours) {
    return { basis: 'notice_served', permitted: true }
  }

  return {
    basis: 'insufficient_notice',
    permitted: false,
    requiredHours: facts.entryNoticeHours,
    // Rounded UP: being 1.2 hours short is being 2 hours short as far as
    // anybody reading a warning is concerned, and rounding down would
    // understate the gap in the one direction that matters.
    shortfallHours: Math.ceil(facts.entryNoticeHours - hoursOfNotice),
  }
}

/// The earliest a visit may START given when notice goes out. What the
/// scheduling form offers as "the soonest compliant window", so staff are
/// steered to a lawful time rather than told off after choosing one.
export function earliestCompliantStart(
  noticeServedAt: Date,
  entryNoticeHours: number | null,
): Date {
  if (entryNoticeHours == null) return noticeServedAt
  return new Date(noticeServedAt.getTime() + entryNoticeHours * 3_600_000)
}

export interface EntryNoticeContext {
  tenantName: string
  addressLine1: string
  unitName: string
  scheduledStart: Date
  scheduledEnd: Date
  reason: string
  /// Property-local, for rendering the window in the tenant's own time (D-3).
  timezone: string
  entryNoticeHours: number | null
}

/**
 * The notice text itself.
 *
 * A DRAFT, and it says so in its own last line. Every legal artifact in this
 * product carries that, per D-4 - this is a learning project, the text has
 * not been reviewed by counsel, and a generated notice that presents itself
 * as authoritative is worse than no notice at all.
 *
 * Plain, dated, specific about the window and the reason. Those three things
 * are what a notice has to contain in every jurisdiction that requires one;
 * anything more ornate is a template concern (COMM-03) and belongs with the
 * managed templates, not hardcoded here.
 */
export function entryNoticeText(context: EntryNoticeContext): string {
  const window = formatWindow(context.scheduledStart, context.scheduledEnd, context.timezone)

  return [
    `Notice of entry`,
    '',
    `Dear ${context.tenantName},`,
    '',
    `This is written notice that we intend to enter your home at ${context.addressLine1}${
      context.unitName ? ` (${context.unitName})` : ''
    } during the following window:`,
    '',
    window,
    '',
    `Reason for entry: ${context.reason}`,
    '',
    context.entryNoticeHours != null
      ? `Your jurisdiction requires at least ${context.entryNoticeHours} hours' notice before a non-emergency entry.`
      : 'We provide advance notice of every non-emergency entry.',
    '',
    'If this time does not work, please contact us and we will arrange another.',
    '',
    '— This notice is a draft generated by the property management system and has not been reviewed by an attorney. It is not legal advice.',
  ].join('\n')
}

function formatWindow(start: Date, end: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(start)
  const time = (value: Date) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(value)

  return `${date}, between ${time(start)} and ${time(end)}`
}
