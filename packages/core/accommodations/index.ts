// Reasonable-accommodation requests (RISK-13 and RISK-03; R-086, widened by
// R-088).
//
// ==========================================================================
// THIS STARTED AS AN ASSISTANCE-ANIMAL FILE AND IS NOW THE GENERAL ONE.
//
// R-086 built it for assistance animals, which are the commonest kind of
// reasonable-accommodation request by a wide margin. R-088 needed the other
// kind: a tenant working through a hoarding case asks for time, for a
// support person at inspections, for an exception to a storage rule - never
// for an animal. The choice was to widen this or to stand a second
// accommodation table beside it, and two tables recording the same statutory
// process is two vocabularies to keep in step and one of them will rot.
//
// So `POLICY_EXCEPTION` joined the two animal kinds. What did NOT change is
// the shape, because the shape was never animal-specific: the FHA framework
// is one framework, and the two observations that decide whether
// documentation may be asked for are the Joint Statement's general rule, not
// an animal rule. The ADA service-animal carve-out is the one genuinely
// animal-shaped thing in here, and it is one branch.
//
// A physical MODIFICATION under §100.203 - a grab bar, a ramp, a widened
// door - is a different animal again, chiefly because the tenant usually
// pays for it and usually has to restore it. It is deliberately NOT a value
// here, and has no home in this product yet.
// ==========================================================================
//
// ==========================================================================
// THIS IS A FAIR-HOUSING FILE, AND IT IS SHAPED AROUND THE MISTAKES.
//
// A reasonable-accommodation request for an assistance animal is, per HUD's
// FHEO-2020-01 guidance and the FHA behind it, one of the most common
// sources of a housing-discrimination complaint. Four mistakes produce
// almost all of them, and each one has a countermeasure here:
//
//   1. CHARGING FOR IT. An assistance animal is not a pet, so no pet fee,
//      no pet deposit, no pet rent, and no breed or size restriction may be
//      applied to it. `PET_MONEY_TYPES` and `petMoneyAllowed` are what stop
//      that at the money, not at a screen.
//   2. ASKING FOR DOCUMENTATION WHEN YOU MAY NOT. Where the disability OR
//      the need is readily observable, requesting medical documentation is
//      itself the violation. `documentationRequestable` decides, and the
//      product asks the two questions that decide it rather than leaving a
//      free-text "we need a letter" box.
//   3. TAKING TOO LONG. HUD's guidance is that a provider should respond
//      "as soon as practicable", and treats more than ten days as
//      unreasonable absent extenuating circumstances. Silence is read as a
//      denial. `responseClock` is the countermeasure and it is why this item
//      raises a Task rather than trusting somebody's inbox.
//   4. DENYING WITHOUT A STATED, LAWFUL BASIS. `validateDetermination`
//      refuses to record a denial with no reason, for the same reason
//      `eviction.case_opened` is REASON_REQUIRED.
//
// WHAT THIS FILE DOES NOT DO is decide whether somebody is disabled, whether
// their documentation is reliable, or whether an animal is a direct threat.
// Those are the provider's judgements and, past a point, their attorney's.
// Same posture as packages/core/notices and packages/core/scra.
// ==========================================================================

import type { BusinessDate } from '../scheduling/local-time.ts'

// ---------------------------------------------------------------------------
// What is being asked for, and what may never be charged for an animal
// ---------------------------------------------------------------------------

/**
 * What kind of accommodation this is. The distinction is not cosmetic — it
 * decides what you are allowed to ASK.
 *
 * A `SERVICE_ANIMAL` is the ADA category: a dog (or miniature horse)
 * individually trained to do work or perform tasks for a person with a
 * disability. Where that is what is presented, the enquiry is limited to two
 * questions and documentation may NOT be required.
 *
 * An `ASSISTANCE_ANIMAL` is the broader FHA category, which includes
 * emotional-support animals. Documentation may be requested only where
 * neither the disability nor the need is readily observable.
 *
 * A `POLICY_EXCEPTION` is everything else the FHA calls a reasonable
 * accommodation: a change to a rule, policy, practice or service. Time to
 * clear a unit, a support person present at an inspection, a reserved
 * parking space, an exception to a storage or occupancy rule, rent accepted
 * on a benefits-payment date. R-088 needed this for hoarding cases
 * (RISK-03), where the accommodation asked for is never an animal. The
 * observability rule applies to it exactly as it does to an assistance
 * animal; only the ADA two-question carve-out does not.
 */
export const ACCOMMODATION_KINDS = [
  'SERVICE_ANIMAL',
  'ASSISTANCE_ANIMAL',
  'POLICY_EXCEPTION',
] as const
export type AccommodationKind = (typeof ACCOMMODATION_KINDS)[number]

export function isAccommodationKind(value: string): value is AccommodationKind {
  return (ACCOMMODATION_KINDS as readonly string[]).includes(value)
}

export const ACCOMMODATION_KIND_LABELS: Record<AccommodationKind, string> = {
  SERVICE_ANIMAL: 'Service animal (ADA — trained to perform a task)',
  ASSISTANCE_ANIMAL: 'Assistance animal (FHA — includes emotional support)',
  POLICY_EXCEPTION: 'A change to a rule, policy, practice or service',
}

/**
 * The kinds that are about an animal. Used where the copy or the rule is
 * genuinely animal-shaped — `PET_MONEY_TYPES`, the ADA carve-out, and the
 * "which animal" half of a determination.
 */
export const ANIMAL_KINDS = ['SERVICE_ANIMAL', 'ASSISTANCE_ANIMAL'] as const
export type AnimalKind = (typeof ANIMAL_KINDS)[number]

export function isAnimalKind(value: string): value is AnimalKind {
  return (ANIMAL_KINDS as readonly string[]).includes(value)
}

/**
 * Money that may never attach to an approved assistance animal.
 *
 * ==========================================================================
 * A LIST IN CORE, NOT A CONDITION AT EACH CALL SITE.
 *
 * Today exactly one writer in this product creates any of these — the
 * recurring-charge action, for `PET_RENT`. `PET_FEE` and the `PET` deposit
 * type exist in the vocabulary with no writer at all yet. Guarding only the
 * live caller would leave the other two to be written later by somebody who
 * has never read this file, which is precisely how the second and third
 * violation happen.
 *
 * So the rule is here, it names all three, and `petMoneyAllowed` is what any
 * writer of pet money is expected to call. A `grep` for this constant is how
 * a future author finds the rule.
 * ==========================================================================
 */
export const PET_MONEY_TYPES = ['PET_RENT', 'PET_FEE', 'PET_DEPOSIT'] as const
export type PetMoneyType = (typeof PET_MONEY_TYPES)[number]

export const PET_MONEY_REFUSAL =
  'This tenancy has an approved assistance animal, which is not a pet — no pet rent, pet fee, pet deposit, or breed or size restriction may be applied to it. Charging one is a fair-housing violation, not a billing preference.'

/**
 * Whether pet money may attach to this tenancy.
 *
 * TAKES THE FACT, NOT THE REQUEST. Whether an approved assistance animal
 * exists is a database question; whether that forbids a charge is this
 * function's. Splitting them is what lets the rule be unit-tested without a
 * database and reused by a writer that already knows the answer.
 *
 * Note what it does NOT say: a household may have an approved assistance
 * animal AND an ordinary pet, and the pet may lawfully be charged for. This
 * product has no pet record to tell the two apart (there is no `Pet` entity
 * — see this item's PROGRESS entry), so it refuses the charge outright and
 * makes the operator resolve it deliberately. Refusing a lawful charge is
 * recoverable; levying an unlawful one is a complaint.
 */
export function petMoneyAllowed(hasApprovedAssistanceAnimal: boolean): boolean {
  return !hasApprovedAssistanceAnimal
}

// ---------------------------------------------------------------------------
// The request, and its states
// ---------------------------------------------------------------------------

export const REQUEST_STATUSES = [
  /// Logged, nothing decided. The clock starts here.
  'RECEIVED',
  /// We have lawfully asked for reliable documentation and are waiting.
  /// The clock KEEPS RUNNING — see `responseClock`.
  'INFO_REQUESTED',
  'APPROVED',
  'DENIED',
  /// The requester withdrew it. Kept, never deleted.
  'WITHDRAWN',
] as const

export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  RECEIVED: 'Received — not yet decided',
  INFO_REQUESTED: 'Documentation requested',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  WITHDRAWN: 'Withdrawn by the requester',
}

const OPEN_STATUSES: ReadonlySet<RequestStatus> = new Set(['RECEIVED', 'INFO_REQUESTED'])

// ---------------------------------------------------------------------------
// What may lawfully be asked
// ---------------------------------------------------------------------------

export interface DocumentationEnquiry {
  kind: AccommodationKind
  /// Is the disability itself readily observable? (A person using a
  /// wheelchair, or who is visibly blind.)
  disabilityObservable: boolean
  /// Is the DISABILITY-RELATED NEED for what is asked readily observable? (A
  /// dog guiding its handler; a wheelchair user asking for the one parking
  /// space by the ramp.) Distinct from the above, and the guidance treats
  /// them as two separate observations — either one being obvious removes
  /// the basis for asking.
  needObservable: boolean
}

export type DocumentationRefusal =
  /// The ADA limits the enquiry for a service animal to two questions, and
  /// documentation is not one of them.
  | 'service_animal'
  /// Readily observable, so there is nothing to verify.
  | 'observable'

export interface DocumentationDecision {
  requestable: boolean
  refusal?: DocumentationRefusal
}

/**
 * Whether reliable documentation may lawfully be requested.
 *
 * Answers "may we ask", never "should we". A provider entitled to ask is
 * free not to, and the fastest approvals are the ones nobody asked about.
 */
export function documentationRequestable(
  enquiry: DocumentationEnquiry,
): DocumentationDecision {
  if (enquiry.kind === 'SERVICE_ANIMAL') {
    return { requestable: false, refusal: 'service_animal' }
  }
  if (enquiry.disabilityObservable || enquiry.needObservable) {
    return { requestable: false, refusal: 'observable' }
  }
  return { requestable: true }
}

export const DOCUMENTATION_REFUSAL_MESSAGES: Record<DocumentationRefusal, string> = {
  service_animal:
    'This is presented as a service animal. The enquiry is limited to whether the animal is required because of a disability and what task it has been trained to perform — you may not require documentation, ask about the disability itself, or ask for a demonstration.',
  observable:
    'The disability or the need for the animal is readily observable, so there is nothing for documentation to verify. Asking anyway is itself the violation this rule exists to prevent.',
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * How long a provider has before silence starts reading as a denial.
 *
 * HUD's FHEO-2020-01 says a provider should respond "as soon as
 * practicable" and treats more than ten days as unreasonable absent
 * extenuating circumstances. A house rule taken from federal guidance, not a
 * statutory deadline, and deliberately NOT a `JurisdictionRule`: the FHA is
 * federal and uniform, the same reasoning packages/core/scra sets out at
 * length (D-82).
 */
export const RESPONSE_TARGET_DAYS = 10

export interface ResponseClock {
  daysOutstanding: number
  /// Null once decided.
  daysRemaining: number | null
  overdue: boolean
  decided: boolean
}

/**
 * Where the response clock stands.
 *
 * ==========================================================================
 * REQUESTING DOCUMENTATION DOES NOT STOP THE CLOCK, and that is deliberate.
 *
 * The obvious build pauses it while waiting on the requester — it feels
 * fair, and it is exactly the shape a complaint is built from: "they asked
 * for a letter they were not entitled to ask for, and then treated the delay
 * as ours." The provider chose to ask; the response is still owed on the
 * original timetable. If the requester genuinely goes quiet, that is what
 * the determination itself records.
 * ==========================================================================
 */
export function responseClock(
  receivedOn: BusinessDate,
  decidedOn: BusinessDate | null,
  today: BusinessDate,
): ResponseClock {
  const end = decidedOn ?? today
  const daysOutstanding = daysBetween(receivedOn, end)
  if (decidedOn) {
    return {
      daysOutstanding,
      daysRemaining: null,
      overdue: daysOutstanding > RESPONSE_TARGET_DAYS,
      decided: true,
    }
  }
  return {
    daysOutstanding,
    daysRemaining: RESPONSE_TARGET_DAYS - daysOutstanding,
    overdue: daysOutstanding > RESPONSE_TARGET_DAYS,
    decided: false,
  }
}

function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const ms = new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()
  return Math.round(ms / 86_400_000)
}

export function clockSummary(clock: ResponseClock): string {
  if (clock.decided) {
    return `Decided in ${clock.daysOutstanding} day${clock.daysOutstanding === 1 ? '' : 's'}.`
  }
  if (clock.overdue) {
    return `Outstanding ${clock.daysOutstanding} days — past the ${RESPONSE_TARGET_DAYS}-day mark HUD treats as unreasonable. An unanswered request reads as a denial.`
  }
  return `Outstanding ${clock.daysOutstanding} day${clock.daysOutstanding === 1 ? '' : 's'} — ${clock.daysRemaining} left of ${RESPONSE_TARGET_DAYS}.`
}

// ---------------------------------------------------------------------------
// The written determination
// ---------------------------------------------------------------------------

interface Violation {
  field: string
  message: string
}

export interface DeterminationInput {
  outcome: 'APPROVED' | 'DENIED'
  /// The written determination itself. RISK-13 asks for a written one, and
  /// this is it — not a status flip with the reasoning in somebody's head.
  determinationText: string
  /// Required for an approval: what is being approved has to be described
  /// well enough that a later dispute about WHICH animal, or about how far
  /// an exception went, has an answer.
  subjectDescription: string
  /// Decides only the wording of the refusal — an animal and a policy
  /// exception need describing for the same reason.
  kind: AccommodationKind
}

/**
 * A determination is refused unless it can be defended.
 *
 * Both outcomes need the written text, not just denials. An approval with no
 * record of what was approved is the one that produces "we never agreed to
 * the second dog" eighteen months later.
 */
export function validateDetermination(input: DeterminationInput): Violation[] {
  const violations: Violation[] = []

  if (input.determinationText.trim().length < 20) {
    violations.push({
      field: 'determinationText',
      message:
        input.outcome === 'DENIED'
          ? 'State the basis for the denial in writing. A denial with no recorded reason is indistinguishable from a discriminatory one, which is the claim it will be defended against.'
          : 'Write the determination out. "Approved" on its own is not a written determination, and it is what a later dispute about scope turns on.',
    })
  }

  if (input.outcome === 'APPROVED' && input.subjectDescription.trim().length < 3) {
    violations.push({
      field: 'subjectDescription',
      message: isAnimalKind(input.kind)
        ? 'Describe the animal being approved — species, and a name if there is one.'
        : 'Write down exactly what was agreed, and for how long. "Approved" against an unrecorded scope is what the disagreement two years from now is about.',
    })
  }

  return violations
}

/**
 * The lawful grounds for denial, offered as prompts rather than as a closed
 * list somebody picks from.
 *
 * NOT AN ENUM, on purpose. A dropdown of denial reasons is a dropdown of
 * things it is safe to say, and it would get used as one — the operator
 * picks the closest label rather than writing what actually happened, and
 * the record becomes worse than free text. These are shown beside the box as
 * a reminder of what the law actually permits.
 */
export const LAWFUL_DENIAL_GROUNDS: readonly string[] = [
  'The requester is not a person with a disability, and no disability-related need was established.',
  'No disability-related need for THIS animal was established after reliable documentation was lawfully requested and not provided.',
  'This specific animal poses a direct threat to the health or safety of others that no reasonable accommodation can reduce.',
  'This specific animal would cause substantial physical damage to the property of others that no reasonable accommodation can reduce.',
  'The accommodation would impose an undue financial and administrative burden, or fundamentally alter the provider’s operations.',
]
