// Confidential safety cases (RISK-04, ROLE-05; R-091). Pure - no database,
// no Next.js.
//
// NOTHING IN THIS MODULE NAMES WHAT IT PROTECTS. RISK-04 is domestic
// violence. Every identifier here says "confidential" and stops, for the same
// reason the table and the route do: a name is read by anyone who reads a
// stack trace, a schema, a browser history or a log line, and the fact this
// case exists is the fact the access control is holding.

import { addBusinessDays, type BusinessDate } from '../scheduling/local-time.ts'

export interface ConfidentialCaseViolation {
  field: string
  message: string
}

/// The classes of documentation a statute typically accepts. A list, not an
/// enum on the row, because WHICH of them a given state accepts is
/// jurisdiction configuration (D-4) - R-091b is what reads that. This is only
/// the vocabulary the form offers.
export const DOCUMENTATION_TYPES = [
  'PROTECTIVE_ORDER',
  'POLICE_REPORT',
  'PROVIDER_STATEMENT',
] as const
export type DocumentationType = (typeof DOCUMENTATION_TYPES)[number]

export const DOCUMENTATION_LABELS: Record<DocumentationType, string> = {
  PROTECTIVE_ORDER: 'Protective or restraining order',
  POLICE_REPORT: 'Police report or incident number',
  PROVIDER_STATEMENT: 'Statement from a victim-services provider or medical professional',
}

/// The same three classes, worded for the jurisdiction rule form, where the
/// question is not "what were you shown" but "what does this state take".
///
/// ITS OWN LABELS RATHER THAN THE ONES ABOVE, and the reason is a strict-mode
/// failure worth keeping: "Statement from a victim-services provider…" put the
/// word STATE inside a checkbox label on a form whose first field is labelled
/// "State", and `getByLabel` is a case-insensitive SUBSTRING match - so four
/// existing specs stopped being able to select a state at all. CLAUDE.md's
/// rule, met head-on: prefer the longer, more specific wording, which is the
/// better label here anyway.
export const DOCUMENTATION_ACCEPTED_LABELS: Record<DocumentationType, string> = {
  PROTECTIVE_ORDER: 'Accepts a protective or restraining order',
  POLICE_REPORT: 'Accepts a police report or incident number',
  PROVIDER_STATEMENT: 'Accepts a provider or medical professional’s documentation',
}

export function isDocumentationType(value: string): value is DocumentationType {
  return (DOCUMENTATION_TYPES as readonly string[]).includes(value)
}

/// Shown next to the documentation fields, every time. The rule it states is
/// D-107's, and an operator who does not know it will do the intuitive thing
/// and scan the order into the filing cabinet, where `document.read` puts it
/// in front of the maintenance tech.
export const DOCUMENTATION_IS_NOT_STORED =
  'Record what you were shown, not the document itself. Do not upload or scan a protective order, police report or provider statement into this system: uploaded documents are readable by every member of staff who can read documents at all, which includes maintenance. Note the class of document, the date, and hand it back.'

export interface ConfidentialCaseInput {
  summary: string
  restrictedPartyName: string
  restrictedPartyTenantId: string | null
  documentationType: string
  /// `YYYY-MM-DD` or empty. A BusinessDate - a calendar day, so no timezone
  /// may touch it (CLAUDE.md's `@db.Date` rule).
  documentedOn: string
  today: string
}

/**
 * Whether a case can be opened.
 *
 * THE LEASE'S STATUS IS NOT AN INPUT, and its absence is the decision. A case
 * can be opened on a tenancy in any state, including one already ended: the
 * risk does not stop when the lease does, and an operator who has just been
 * told something at 11pm should not meet a refusal because the tenancy ended
 * last week. The one thing required is a summary, because a restricted case
 * nobody can make sense of six months later protects nothing.
 *
 * DOCUMENTATION IS OPTIONAL AT OPENING, ALWAYS. A survivor who has not yet
 * been to court has no order to show, and a product that demanded one before
 * it would change the locks would be holding somebody's safety against a
 * filing deadline. What documentation gates is the statutory early-
 * termination right (R-091b), not the operational response.
 */
export function validateConfidentialCase(
  input: ConfidentialCaseInput,
): ConfidentialCaseViolation[] {
  const violations: ConfidentialCaseViolation[] = []

  if (!input.summary.trim()) {
    violations.push({
      field: 'summary',
      message: 'Say what is going on. Nobody outside this case will see it.',
    })
  }

  // The database enforces the same pairing, from the other side: a tenant id
  // with no name is a case that stops making sense the moment that Tenant row
  // is retired.
  if (input.restrictedPartyTenantId && !input.restrictedPartyName.trim()) {
    violations.push({
      field: 'restrictedPartyName',
      message: 'Name the person as well as choosing them, so the record still reads later.',
    })
  }

  const hasType = Boolean(input.documentationType)
  const hasDate = Boolean(input.documentedOn)
  if (hasType !== hasDate) {
    violations.push({
      field: 'documentedOn',
      message: 'Documentation needs both what you were shown and the date you saw it.',
    })
  }
  if (hasType && !isDocumentationType(input.documentationType)) {
    violations.push({ field: 'documentationType', message: 'Choose what you were shown.' })
  }
  if (hasDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.documentedOn)) {
    violations.push({ field: 'documentedOn', message: 'Give the date you were shown it.' })
  } else if (hasDate && input.documentedOn > input.today) {
    violations.push({ field: 'documentedOn', message: 'That date has not happened yet.' })
  }

  return violations
}

// ---------------------------------------------------------------------------
// The lock change
// ---------------------------------------------------------------------------

/// The work order's own description. An ordinary re-key, worded as one.
///
/// It says nothing about why, because a work order is dispatched to an
/// external vendor through R-025's magic link, appears on every maintenance
/// screen, and is read by whoever is on the phone when the locksmith calls
/// back. The urgency carries in the priority, not in an explanation.
export const LOCK_CHANGE_SCOPE =
  'Re-key or replace all exterior locks on this unit, including any secondary entrances, garage entry and mailbox if keyed to the same set. Same day if possible. Provide the full new key set to the property manager on completion; do not leave keys in a lockbox.'

/**
 * The instruction the person at the door must not miss.
 *
 * NAMES ONLY WHO IS AUTHORIZED. "Do not give keys to John Smith" tells a
 * locksmith something about a household that is not theirs to know and that
 * they may repeat to the next person who asks; naming only the person who MAY
 * receive keys is the same protection with nothing disclosed. A vendor who
 * follows it exactly cannot hand keys to the restricted party without having
 * been told the restricted party exists.
 *
 * The callback line matters as much as the rest: the failure this is guarding
 * against is somebody plausible turning up and asking, and a vendor with no
 * instruction improvises.
 */
export function restrictedPartyNote(input: {
  authorizedNames: readonly string[]
  callbackLabel: string
}): string {
  const names =
    input.authorizedNames.length > 0 ? input.authorizedNames.join(' or ') : 'the property manager'
  return [
    `Release keys, codes and access for this job ONLY to ${names}, in person.`,
    'Do not leave keys with anybody else, do not post them, and do not leave them on site.',
    `If anybody else asks you about this job, this address or who lives here — including someone who says they live here or owns it — say nothing and call ${input.callbackLabel} first.`,
  ].join(' ')
}

// ---------------------------------------------------------------------------
// The statutory early-termination right (R-091b)
// ---------------------------------------------------------------------------
//
// ==========================================================================
// THIS ONE *IS* JURISDICTION CONFIGURATION, AND THAT IS THE WHOLE POINT OF
// SPLITTING IT FROM R-085.
//
// D-82 hardcodes the SCRA because §§3931/3955 are federal, uniform across
// fifty states, and preempt state law where they disagree - so a
// `JurisdictionRule` column for §3955 would be a configuration point with one
// correct value in fifty rows and fifty chances to get one wrong.
//
// A survivor's right to end a tenancy early without penalty is the opposite.
// VAWA binds federally assisted housing; a private single-family portfolio
// answers to state law - e.g. Tex. Prop. Code §92.016 (family violence) and
// §92.0161 (certain sexual offences and stalking) - and states differ on
// whether the right exists at all, how much notice it takes, and which
// classes of documentation the statute accepts. D-4 applies unchanged.
//
// AND, LIKE §3955, IT DOES NOT RUN THROUGH `noticePeriodCheck`. The state's
// `noticeToVacateDays` is not a floor a survivor has to clear; the
// early-termination statute is what governs the date, and demanding an
// override reason from somebody exercising a statutory right is the product
// getting the law backwards (D-82's reasoning, applied to a different
// statute).
// ==========================================================================

/// What the jurisdiction says. Three-valued on the first field, because
/// "nobody has reviewed this state" is a different claim from "this state
/// grants no such right" and the two need different messages and different
/// remedies - one is a five-minute config edit, the other is a legal
/// conclusion somebody has already reached.
export interface EarlyTerminationRule {
  rightExists: boolean | null
  noticeDays: number | null
  /// EMPTY IS NOT "NONE". It means nobody has itemised which classes this
  /// state accepts, and the decision below then takes any class actually
  /// recorded on the case rather than refusing over this product's own gap.
  acceptedDocumentationTypes: readonly string[]
}

export const EARLY_TERMINATION_REFUSALS = [
  'rule_not_reviewed',
  'right_not_granted',
  'notice_period_not_configured',
  'no_documentation',
  'documentation_not_accepted',
  'delivered_in_future',
] as const
export type EarlyTerminationRefusal = (typeof EARLY_TERMINATION_REFUSALS)[number]

/// Read on a page that is already behind the permission wall, so these can be
/// direct - but they still never name what the case is about, because the
/// wall is not the only way a screen gets read (D-107).
export const EARLY_TERMINATION_REFUSAL_MESSAGES: Record<EarlyTerminationRefusal, string> = {
  rule_not_reviewed:
    'Nobody has reviewed whether this state grants an early-termination right, so this product cannot compute the date it would take effect. Add it to the jurisdiction rule for this state, then come back. This is a gap in our configuration, not an answer about the law — it does not mean the right does not exist, and it does not stop you honouring it outside this screen.',
  right_not_granted:
    'The reviewed rule for this state records no statutory early-termination right, so there is no statutory date to compute. Ending the tenancy by agreement or on ordinary notice is still open, on the tenancy itself.',
  notice_period_not_configured:
    'This state grants the right but its notice period is not on file, so the effective date cannot be computed. Add it to the jurisdiction rule for this state.',
  no_documentation:
    'The statutory right is the one thing documentation gates. Record what you were shown and the date, on this case, first. Nothing else here waits on it — the lock change never did.',
  documentation_not_accepted:
    'What was recorded on this case is not a class this state accepts for the statutory right. It changes nothing else about the case.',
  delivered_in_future: 'Notice cannot be recorded as delivered on a date that has not happened.',
}

export interface EarlyTerminationInput {
  /// The day the tenant delivered written notice. A BusinessDate.
  deliveredOn: string
  today: string
  rule: EarlyTerminationRule
  /// Taken from the case, never from the form. D-108: what the statute turns
  /// on is that documentation of an accepted class was PRODUCED, which is a
  /// fact already recorded, whole, by a database CHECK.
  documentationType: string | null
  documentedOn: string | null
}

export type EarlyTerminationDecision =
  | { refusal: EarlyTerminationRefusal; effectiveOn?: undefined; noticeDays?: undefined }
  | { refusal?: undefined; effectiveOn: BusinessDate; noticeDays: number }

/**
 * When a statutory early termination takes effect, or why it cannot be
 * recorded.
 *
 * REFUSES RATHER THAN GUESSES, in every branch. The alternative is a computed
 * termination date resting on a statute nobody has read, printed on a record
 * that says the tenant exercised a right — and a wrong date here ends
 * somebody's tenancy on the wrong day and releases the wrong month of rent.
 *
 * WHAT IT NEVER BLOCKS is the safety response. The lock change, the retired
 * codes and the case itself are R-091's and are reached from the same page
 * without passing through here. Documentation gates the statutory CLAIM only
 * (D-108) — a survivor who has not been to court has no order to show, and a
 * product that would not change the locks until they did would be holding
 * somebody's safety against a filing deadline.
 */
export function earlyTermination(input: EarlyTerminationInput): EarlyTerminationDecision {
  if (input.deliveredOn > input.today) return { refusal: 'delivered_in_future' }
  if (input.rule.rightExists == null) return { refusal: 'rule_not_reviewed' }
  if (!input.rule.rightExists) return { refusal: 'right_not_granted' }
  if (!input.documentationType || !input.documentedOn) return { refusal: 'no_documentation' }
  if (
    input.rule.acceptedDocumentationTypes.length > 0 &&
    !input.rule.acceptedDocumentationTypes.includes(input.documentationType)
  ) {
    return { refusal: 'documentation_not_accepted' }
  }
  // Zero is a real configuration - a state where the tenancy ends the day
  // notice is delivered - so this tests for null, not for falsiness.
  if (input.rule.noticeDays == null) return { refusal: 'notice_period_not_configured' }

  return {
    effectiveOn: addBusinessDays(input.deliveredOn, input.rule.noticeDays),
    noticeDays: input.rule.noticeDays,
  }
}

/// Printed on the panel, verbatim. The two halves a survivor and an owner
/// each ask about, and they have opposite answers: future rent goes, past
/// arrears do not (e.g. Tex. Prop. Code §92.016(f)). Stated because an
/// operator who assumes the first also wipes the second is about to write off
/// money nobody agreed to write off — and one who assumes neither is about to
/// pursue rent the statute released.
export const EARLY_TERMINATION_LIABILITY_NOTE =
  'Recording this ends the tenancy on the computed date and stops rent accruing after it. It does not clear anything already owed on the day it ends, and it does not itself refund the deposit — the deposit runs its ordinary disposition from the move-out.'

// ---------------------------------------------------------------------------
// Removing the restricted party from the tenancy
// ---------------------------------------------------------------------------

/// The reason printed on a bifurcation amendment and copied into
/// `lease.party_changed`'s audit payload.
///
/// A FIXED STRING, NOT SOMETHING AN OPERATOR TYPES. The ordinary path takes a
/// free-text reason and should: a roommate change with no stated reason is
/// the one a dispute asks about. Here the same field is read by every signer,
/// lands in an archived `Document` that `document.read` exposes to the
/// maintenance tech, and is copied into an audit row - so a free-text box is
/// an invitation to type the one sentence this whole feature exists to keep
/// off those screens (D-107).
export const BIFURCATION_REASON =
  'Removal of a party from the tenancy under a statutory right. The remaining tenancy continues unchanged on its existing terms.'

/// Shown on the panel before it is used. The consequence an operator has to
/// have understood, because the product cannot check it for them.
export const BIFURCATION_IS_NOT_AN_EVICTION =
  'This removes them from the lease. It does not remove them from the property, and it is not a notice, a lockout or an eviction — doing any of those on the strength of this alone would be a self-help eviction. What it changes is who is liable on the tenancy and who this system will contact, message and let into the portal.'
