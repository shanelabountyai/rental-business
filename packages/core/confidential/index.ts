// Confidential safety cases (RISK-04, ROLE-05; R-091). Pure - no database,
// no Next.js.
//
// NOTHING IN THIS MODULE NAMES WHAT IT PROTECTS. RISK-04 is domestic
// violence. Every identifier here says "confidential" and stops, for the same
// reason the table and the route do: a name is read by anyone who reads a
// stack trace, a schema, a browser history or a log line, and the fact this
// case exists is the fact the access control is holding.

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
