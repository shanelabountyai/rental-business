// Tenant goes dark / abandonment (RISK-01, R-087).
//
// ==========================================================================
// THE CASE FILE IS THE PROTECTION, AND THE RISK RUNS BOTH WAYS.
//
// RISK-01's own closing line: "done wrong, this converts to an
// unlawful-eviction claim". That is the headline risk and it is not the only
// one — this workflow sits between two opposite failures, and a product that
// only guards one of them makes the other worse:
//
//   * ACT TOO SOON and you have re-entered, re-keyed and binned the
//     belongings of a tenant who was in hospital for three weeks. That is a
//     self-help eviction plus conversion, and no amount of unpaid rent makes
//     it lawful.
//   * ACT TOO LATE, or without ever entering, and a genuinely abandoned unit
//     sits accruing damage nobody has seen — a burst pipe, a pet locked in,
//     a person who has died alone in it.
//
// So nothing here declares a unit abandoned. It records what was tried, when,
// and by what means; it computes the two clocks the statutes turn on; and it
// refuses exactly one thing — disposing of somebody's property before the
// storage period has run, which is the one act that cannot be undone.
//
// EVERY PERIOD IS JURISDICTION CONFIGURATION (D-4). Texas, California and
// Florida each answer "how long must you hold their things" differently, and
// several answer it differently again depending on the value of the goods.
// Nothing in this file is a number.
// ==========================================================================

import { addBusinessDays, type BusinessDate } from '../scheduling/local-time.ts'

// ---------------------------------------------------------------------------
// Contact attempts
// ---------------------------------------------------------------------------

/**
 * How somebody was reached for, or looked for.
 *
 * NOT a subset of the messaging channels. Three of these send nothing at all
 * — knocking on a door, asking a neighbour, and looking at whether the car is
 * there are exactly the evidence an abandonment finding rests on, and none of
 * them is a `Message`. That is why this workflow logs its own attempts rather
 * than reading the comms thread.
 */
export const CONTACT_METHODS = [
  'PHONE_CALL',
  'TEXT',
  'EMAIL',
  'LETTER',
  /// Somebody physically went there.
  'DOOR_KNOCK',
  /// The emergency contact the lease carries.
  'EMERGENCY_CONTACT',
  /// A neighbour, an employer, a relative who is not the emergency contact.
  'THIRD_PARTY',
  /// A welfare check by police or a wellbeing service. Its own method
  /// because a landlord who called the police and a landlord who knocked
  /// twice are in very different positions afterwards.
  'WELFARE_AUTHORITY',
] as const

export type ContactMethod = (typeof CONTACT_METHODS)[number]

export function isContactMethod(value: string): value is ContactMethod {
  return (CONTACT_METHODS as readonly string[]).includes(value)
}

export const CONTACT_METHOD_LABELS: Record<ContactMethod, string> = {
  PHONE_CALL: 'Phone call',
  TEXT: 'Text message',
  EMAIL: 'Email',
  LETTER: 'Letter',
  DOOR_KNOCK: 'Knocked at the home',
  EMERGENCY_CONTACT: 'Emergency contact on the lease',
  THIRD_PARTY: 'Neighbour, employer or relative',
  WELFARE_AUTHORITY: 'Welfare check by police or a wellbeing service',
}

export const CONTACT_OUTCOMES = ['NO_ANSWER', 'REACHED', 'UNDELIVERABLE', 'INFORMATION'] as const
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number]

export function isContactOutcome(value: string): value is ContactOutcome {
  return (CONTACT_OUTCOMES as readonly string[]).includes(value)
}

export const CONTACT_OUTCOME_LABELS: Record<ContactOutcome, string> = {
  NO_ANSWER: 'No answer',
  REACHED: 'Reached them',
  UNDELIVERABLE: 'Undeliverable — bounced, disconnected, returned',
  INFORMATION: 'Learned something from somebody else',
}

// ---------------------------------------------------------------------------
// Is the evidence good enough yet?
// ---------------------------------------------------------------------------

/**
 * How many attempts, across how many distinct methods, before this product
 * stops calling the evidence thin.
 *
 * A HOUSE RULE, NOT A STATUTE, and it is labelled as one everywhere it
 * surfaces. No state says "three attempts by two methods"; what they say is
 * that the landlord must have a reasonable belief, and what a court actually
 * looks at is whether anybody seriously tried. Two phone calls to a
 * disconnected number is not trying. This is the bar the product nags about
 * — it never blocks on it, because an operator who has a genuine reason to
 * move faster (a smell, a neighbour's report) should not be arguing with a
 * counter.
 */
export const MIN_ATTEMPTS = 3
export const MIN_DISTINCT_METHODS = 2

export interface EvidenceFacts {
  attempts: readonly { method: ContactMethod; outcome: ContactOutcome }[]
  /// Days since the last sign of the tenant — the most recent payment,
  /// message, or anything else. Null when nothing is known either way.
  daysSinceContact: number | null
  /// `JurisdictionRule.abandonmentPresumedAfterDays`. Null means this
  /// product has not been taught the state's rule.
  presumedAfterDays: number | null
  /// Is rent actually unpaid? Several states make that a precondition, and
  /// none of them treats a paid-up tenancy as abandoned however quiet.
  rentUnpaid: boolean
}

export interface EvidenceAssessment {
  /// Somebody answered. Whatever else is true, this is not abandonment.
  reached: boolean
  attemptCount: number
  distinctMethods: number
  /// House-rule bar met.
  attemptsSufficient: boolean
  /// The state's own silence period, where configured and where known.
  statutoryPeriodMet: boolean | null
  /// True when this product has no configured period for the state.
  periodUnknown: boolean
  /// Everything that is not yet true, in words, for the screen.
  gaps: string[]
}

export function assessEvidence(facts: EvidenceFacts): EvidenceAssessment {
  const reached = facts.attempts.some((attempt) => attempt.outcome === 'REACHED')
  const attemptCount = facts.attempts.length
  const distinctMethods = new Set(facts.attempts.map((attempt) => attempt.method)).size
  const attemptsSufficient =
    attemptCount >= MIN_ATTEMPTS && distinctMethods >= MIN_DISTINCT_METHODS
  const periodUnknown = facts.presumedAfterDays == null

  const statutoryPeriodMet = periodUnknown
    ? null
    : facts.daysSinceContact != null && facts.daysSinceContact >= facts.presumedAfterDays!

  const gaps: string[] = []
  if (reached) {
    gaps.push(
      'Somebody answered. Whatever else is true here, a tenancy where the tenant has responded is not abandoned.',
    )
  }
  if (!attemptsSufficient) {
    gaps.push(
      `Only ${attemptCount} attempt${attemptCount === 1 ? '' : 's'} across ${distinctMethods} method${distinctMethods === 1 ? '' : 's'} on file. This product asks for ${MIN_ATTEMPTS} across ${MIN_DISTINCT_METHODS} before calling the evidence solid — that is a house rule, not a statute, and what a court actually asks is whether anybody seriously tried.`,
    )
  }
  if (!facts.rentUnpaid) {
    gaps.push(
      'Rent is not in arrears. A quiet tenancy that is paid up is not an abandoned one, and several states make unpaid rent a precondition.',
    )
  }
  if (periodUnknown) {
    gaps.push(
      'This state’s abandonment period is not configured in this system, so no statutory clock is shown. Ask your attorney — a period guessed here is the one that turns this into a self-help eviction.',
    )
  } else if (statutoryPeriodMet === false) {
    gaps.push(
      `It is ${facts.daysSinceContact ?? 'an unknown number of'} days since any sign of the tenant; the configured period is ${facts.presumedAfterDays}.`,
    )
  }

  return {
    reached,
    attemptCount,
    distinctMethods,
    attemptsSufficient,
    statutoryPeriodMet,
    periodUnknown,
    gaps,
  }
}

// ---------------------------------------------------------------------------
// The belongings clock — the one thing this module refuses
// ---------------------------------------------------------------------------

export interface BelongingsFacts {
  /// The day the property was inventoried and secured. The clock runs from
  /// here, not from when the tenant was last seen.
  heldFrom: BusinessDate
  /// `JurisdictionRule.belongingsStorageDays`. Null means unconfigured.
  storageDays: number | null
  /// `JurisdictionRule.belongingsNoticeDays` — notice to the tenant before
  /// disposal, where the state requires one on top of the storage period.
  noticeDays: number | null
  /// When notice of intended disposal was actually sent, if it was.
  noticeSentOn: BusinessDate | null
  today: BusinessDate
}

export type DisposalRefusal =
  /// This product does not know the state's storage period. Refuses, and
  /// this is the ONE place an unconfigured rule blocks rather than warns —
  /// see `disposalReadiness`.
  | 'period_unknown'
  /// The storage period has not run.
  | 'still_storing'
  /// The state requires notice before disposal and none was sent.
  | 'notice_not_sent'
  /// Notice was sent but its own period has not run.
  | 'notice_period_running'

export interface DisposalReadiness {
  allowed: boolean
  refusal?: DisposalRefusal
  /// The earliest lawful disposal date, where it can be computed.
  earliestOn?: BusinessDate
  daysRemaining?: number
}

/**
 * Whether the tenant's belongings may lawfully be disposed of.
 *
 * ==========================================================================
 * THE ONE HARD REFUSAL IN THIS MODULE, AND THE ONE PLACE AN UNCONFIGURED
 * JURISDICTION RULE BLOCKS INSTEAD OF WARNING.
 *
 * Everywhere else in this product an unknown statutory period is reported and
 * the decision left with the human — R-083's cure clock does it, R-044's
 * grace period does it, and `assessEvidence` above does it. The reasoning is
 * always the same: this product substituting its own ignorance for an
 * attorney's advice is worse than saying "not configured".
 *
 * Disposal is the exception, because it is the only step here that cannot be
 * undone. A premature entry can be apologised for; a premature notice can be
 * re-served. Somebody's photographs, documents and medication, once in a
 * skip, are gone — and conversion is a tort with damages attached. The safe
 * direction for every other clock is "let them proceed and record it"; here
 * the safe direction is "stop".
 * ==========================================================================
 */
export function disposalReadiness(facts: BelongingsFacts): DisposalReadiness {
  if (facts.storageDays == null) return { allowed: false, refusal: 'period_unknown' }

  const storageEndsOn = addBusinessDays(facts.heldFrom, facts.storageDays)
  if (facts.today < storageEndsOn) {
    return {
      allowed: false,
      refusal: 'still_storing',
      earliestOn: storageEndsOn,
      daysRemaining: daysBetween(facts.today, storageEndsOn),
    }
  }

  // Notice is an ADDITIONAL requirement where the state has one, not an
  // alternative to storing. A state with no configured notice period is
  // satisfied by the storage period alone.
  if (facts.noticeDays != null && facts.noticeDays > 0) {
    if (!facts.noticeSentOn) return { allowed: false, refusal: 'notice_not_sent' }
    const noticeEndsOn = addBusinessDays(facts.noticeSentOn, facts.noticeDays)
    if (facts.today < noticeEndsOn) {
      return {
        allowed: false,
        refusal: 'notice_period_running',
        earliestOn: noticeEndsOn,
        daysRemaining: daysBetween(facts.today, noticeEndsOn),
      }
    }
    return { allowed: true, earliestOn: noticeEndsOn }
  }

  return { allowed: true, earliestOn: storageEndsOn }
}

export const DISPOSAL_REFUSAL_MESSAGES: Record<DisposalRefusal, string> = {
  period_unknown:
    'This state’s storage period for a tenant’s belongings is not configured in this system, so there is no date to say the hold has run. Disposing of somebody’s property on a guessed period is conversion — configure the jurisdiction rule, or ask your attorney for the number.',
  still_storing:
    'The storage period has not run. Their things stay where they are, inventoried and secured, until it has.',
  notice_not_sent:
    'This state requires notice of intended disposal before anything can be got rid of, and none has been sent on this case.',
  notice_period_running:
    'Notice has been sent and its own period is still running. Disposal is not lawful until it has expired.',
}

function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const ms = new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()
  return Math.round(ms / 86_400_000)
}

// ---------------------------------------------------------------------------
// The case's own shape
// ---------------------------------------------------------------------------

export const ABANDONMENT_STATUSES = [
  /// Contact attempts are being logged. Nothing has been entered.
  'MONITORING',
  /// The unit has been entered and what was found is on the record.
  'ENTERED',
  /// Belongings are inventoried and held; the storage clock is running.
  'BELONGINGS_HELD',
  'CLOSED',
] as const

export type AbandonmentStatus = (typeof ABANDONMENT_STATUSES)[number]

export const ABANDONMENT_STATUS_LABELS: Record<AbandonmentStatus, string> = {
  MONITORING: 'Monitoring — logging contact attempts',
  ENTERED: 'Entered and documented',
  BELONGINGS_HELD: 'Belongings held — storage clock running',
  CLOSED: 'Closed',
}

/**
 * How it ended.
 *
 * `TENANT_RETURNED` is first-class and listed first, for the same reason
 * `CASH_FOR_KEYS` leads the eviction outcomes: it is the outcome most likely
 * to be the right one, and burying it would let the product read as though
 * abandonment were the expected destination of every quiet tenancy.
 */
export const ABANDONMENT_OUTCOMES = [
  'TENANT_RETURNED',
  'TENANT_REACHED_AND_SURRENDERED',
  'DECEASED',
  'ABANDONED_AND_RECOVERED',
  'CONVERTED_TO_EVICTION',
] as const

export type AbandonmentOutcome = (typeof ABANDONMENT_OUTCOMES)[number]

export function isAbandonmentOutcome(value: string): value is AbandonmentOutcome {
  return (ABANDONMENT_OUTCOMES as readonly string[]).includes(value)
}

export const ABANDONMENT_OUTCOME_LABELS: Record<AbandonmentOutcome, string> = {
  TENANT_RETURNED: 'The tenant came back',
  TENANT_REACHED_AND_SURRENDERED: 'Reached them; they gave up the tenancy',
  DECEASED: 'The tenant had died',
  ABANDONED_AND_RECOVERED: 'Abandoned — possession recovered',
  CONVERTED_TO_EVICTION: 'Went to eviction instead',
}

/**
 * What closing as DECEASED implies, said once here so no screen has to
 * remember it.
 *
 * Recorded as a pointer rather than automated: R-084's `deceased` hold is the
 * thing that actually stops the automation, and placing it is a decision with
 * a reason attached, not a side effect of picking an option from a list.
 */
export const DECEASED_OUTCOME_PROMPT =
  'Place a “tenant deceased” hold on the tenancy as well. Possession passes through the estate, and nothing in the home may be released except to the legally entitled party — the hold is what stops the chase, the late fees and the access changes.'
