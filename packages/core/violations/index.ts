// Lease-violation case files: unauthorized occupants, unauthorized animals,
// and the conditions a hoarding case is actually enforced on (RISK-02,
// RISK-03, R-088).
//
// ==========================================================================
// THERE IS NO `HOARDING` KIND HERE, AND ITS ABSENCE IS THE DESIGN.
//
// RISK-03 asks for a violation-notice series "targeting lease/safety terms
// (blocked egress, fire load, pests) - never the person". You cannot serve a
// notice for hoarding. There is no lease term against it and no code section
// naming it; what is enforceable is the blocked exit, the pest harborage,
// the furnace nobody can reach. Hoarding disorder is also a recognised
// disability, which makes a case file headed with the word both unenforceable
// AND the single most quotable document in the complaint that follows.
//
// So a hoarding case is a `PREMISES_CONDITION` case, every observation on it
// names a `ViolationGround` from a closed vocabulary of enforceable terms,
// and that vocabulary contains no word for a person, a diagnosis, or a
// standard of housekeeping. The enum IS the guardrail: a free-text box is
// where "hoarder" gets typed.
//
// The other half of RISK-03 - accommodation-request tracking - is NOT here.
// It is packages/core/accommodations, widened by this item from
// assistance-animals-only to the general reasonable-accommodation framework,
// because a hoarding accommodation is never an animal and a second table
// would be a second vocabulary to keep in step.
// ==========================================================================
//
// WHAT THIS FILE DOES NOT DO is decide whether a violation occurred, whether
// an accommodation is reasonable, or whether to evict. It refuses records
// that would prove nothing, and it warns loudly at the two moments a
// fair-housing complaint is made. Same posture as packages/core/notices,
// packages/core/scra and packages/core/abandonment.

import type { BusinessDate } from '../scheduling/local-time.ts'

// ---------------------------------------------------------------------------
// What is alleged
// ---------------------------------------------------------------------------

export const VIOLATION_KINDS = [
  /// Somebody is living there who is not on the lease. RISK-02's headline,
  /// and the one whose commonest real outcome is legitimization.
  'UNAUTHORIZED_OCCUPANT',
  /// An animal is there that the lease does not permit. Deliberately
  /// "animal", not "pet" - whether it is a pet is exactly what may be in
  /// dispute, and calling it one in the case file answers the question the
  /// wrong way round. See `animalCaseFork`.
  'UNAUTHORIZED_ANIMAL',
  /// The state of the premises breaches a lease or safety term. Every
  /// observation names which one.
  'PREMISES_CONDITION',
] as const

export type ViolationKind = (typeof VIOLATION_KINDS)[number]

export function isViolationKind(value: string): value is ViolationKind {
  return (VIOLATION_KINDS as readonly string[]).includes(value)
}

export const VIOLATION_KIND_LABELS: Record<ViolationKind, string> = {
  UNAUTHORIZED_OCCUPANT: 'Somebody living there who is not on the lease',
  UNAUTHORIZED_ANIMAL: 'An animal the lease does not permit',
  PREMISES_CONDITION: 'The state of the premises breaches a lease or safety term',
}

/**
 * The enforceable grounds a `PREMISES_CONDITION` observation may name.
 *
 * ==========================================================================
 * A CLOSED LIST, AND EVERY ENTRY IS SOMETHING YOU COULD PUT IN A NOTICE.
 *
 * Each of these maps to a term a lease or a fire/health code actually
 * contains, so a notice citing one says what has to be fixed and by whom.
 * None of them describes a person. That is not squeamishness: a notice
 * citing the tenant's housekeeping, character or apparent condition is
 * unenforceable (there is no such lease term) and is evidence of
 * discrimination on the basis of a disability, which hoarding disorder is.
 *
 * The list being closed is what stops "hoarding" being typed into it. If a
 * real situation does not fit one of these, the honest answer is that there
 * may be nothing to enforce yet - not that the vocabulary needs widening
 * with a word about the tenant.
 * ==========================================================================
 */
export const VIOLATION_GROUNDS = [
  'BLOCKED_EGRESS',
  'FIRE_LOAD',
  'PEST_HARBORAGE',
  'SANITATION',
  'SYSTEMS_INACCESSIBLE',
] as const

export type ViolationGround = (typeof VIOLATION_GROUNDS)[number]

export function isViolationGround(value: string): value is ViolationGround {
  return (VIOLATION_GROUNDS as readonly string[]).includes(value)
}

export const VIOLATION_GROUND_LABELS: Record<ViolationGround, string> = {
  BLOCKED_EGRESS: 'A required exit, window or corridor is obstructed',
  FIRE_LOAD: 'Combustible material stored against heat sources or in quantity',
  PEST_HARBORAGE: 'Conditions harbouring pests or vermin',
  SANITATION: 'Waste, spoiled food or sewage not being dealt with',
  SYSTEMS_INACCESSIBLE: 'Furnace, water heater, electrical panel or shut-off cannot be reached',
}

/**
 * The sentence that goes beside every notice generated from a condition
 * case, and beside the ground picker itself.
 *
 * Stated in core rather than in a component because it is the rule, not the
 * copy: a second surface that serves notices needs it too, and prose that
 * lives only in one panel does not travel.
 */
export const NOTICE_LANGUAGE_RULE =
  'Cite the condition and the lease or code term it breaches, and say what has to change. Do not describe the tenant, their housekeeping, their health or their character — that is not a term anybody can cure, and hoarding disorder is a disability, so a notice written that way is both unenforceable and the document a discrimination claim is built from.'

// ---------------------------------------------------------------------------
// The case, and how it ends
// ---------------------------------------------------------------------------

export const VIOLATION_STATUSES = ['OPEN', 'CLOSED'] as const
export type ViolationStatus = (typeof VIOLATION_STATUSES)[number]

export function isViolationStatus(value: string): value is ViolationStatus {
  return (VIOLATION_STATUSES as readonly string[]).includes(value)
}

export const VIOLATION_STATUS_LABELS: Record<ViolationStatus, string> = {
  OPEN: 'Open',
  CLOSED: 'Closed',
}

/**
 * There are deliberately only two statuses. The stage a case has reached is
 * the notice series hanging off it - served, cure period running, expired -
 * and `packages/core/evictions`' `cureClock` already reads that from the
 * `NoticeDelivery` rows. A `NOTICE_SERVED` status here would be a second
 * copy of a fact the notices already hold, and the two would disagree the
 * first time a service was recorded from the notices screen.
 */
export const VIOLATION_OUTCOMES = [
  /// The occupant left, the animal went, the condition was corrected.
  'CURED',
  /// Brought within the lease. The common real-world outcome RISK-02 names,
  /// and the reason this product treats it as a first-class exit rather than
  /// as "case closed, no action".
  'LEGITIMIZED',
  /// A reasonable accommodation was approved and the demand withdrawn or
  /// modified to match it.
  'ACCOMMODATED',
  /// There was no violation, or we were wrong about who or what we saw.
  'WITHDRAWN',
  /// Handed to the eviction path.
  'ESCALATED',
] as const

export type ViolationOutcome = (typeof VIOLATION_OUTCOMES)[number]

export function isViolationOutcome(value: string): value is ViolationOutcome {
  return (VIOLATION_OUTCOMES as readonly string[]).includes(value)
}

export const VIOLATION_OUTCOME_LABELS: Record<ViolationOutcome, string> = {
  CURED: 'Cured — the occupant, animal or condition is gone',
  LEGITIMIZED: 'Legitimized — brought within the lease',
  ACCOMMODATED: 'Accommodated — an accommodation was approved instead',
  WITHDRAWN: 'Withdrawn — there was no violation',
  ESCALATED: 'Escalated to eviction',
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

interface Violation {
  field: string
  message: string
}

export interface ObservationInput {
  kind: ViolationKind
  /// Required for `PREMISES_CONDITION`, meaningless for the other two - the
  /// ground there IS the kind.
  ground: ViolationGround | null
  observedOn: BusinessDate
  note: string
}

/**
 * An observation is refused unless it names something enforceable.
 *
 * The `ground` requirement is the whole mechanism described at the top of
 * this file. Without it a condition case is a dated note saying "it's bad in
 * there", which is worse evidence than nothing: it dates our knowledge
 * without recording anything we could act on.
 */
export function validateObservation(input: ObservationInput, today: BusinessDate): Violation[] {
  const violations: Violation[] = []

  if (input.kind === 'PREMISES_CONDITION' && input.ground == null) {
    violations.push({
      field: 'ground',
      message:
        'Name the lease or safety term this breaches. A condition with no term behind it is not a violation yet, and a notice citing one cannot be written.',
    })
  }

  if (input.kind !== 'PREMISES_CONDITION' && input.ground != null) {
    violations.push({
      field: 'ground',
      message: 'A ground belongs only to a premises-condition case — here the kind of case is the ground.',
    })
  }

  if (input.note.trim().length < 10) {
    violations.push({
      field: 'note',
      message:
        'Write down what was actually seen, and where. Photographs prove the state of a room; only the note says which room and why it matters.',
    })
  }

  if (input.observedOn > today) {
    violations.push({ field: 'observedOn', message: 'An observation cannot be dated in the future.' })
  }

  return violations
}

// ---------------------------------------------------------------------------
// The animal fork - RISK-02 meeting RISK-13
// ---------------------------------------------------------------------------

export type AnimalFork =
  /// An accommodation request on this tenancy is undecided. Whether this
  /// animal is an unauthorized pet is the question that request answers.
  | 'request_undecided'
  /// An assistance animal is already approved here.
  | 'already_approved'
  /// Nothing on file. Proceed, but ask.
  | 'ask_first'

export const ANIMAL_FORK_MESSAGES: Record<AnimalFork, string> = {
  request_undecided:
    'There is an undecided accommodation request on this tenancy. Whether this animal is an unauthorized pet may be exactly what that request answers — decide it before serving on the animal, and note that the response is owed within ten days either way.',
  already_approved:
    'This tenancy already has an approved assistance animal. An approved assistance animal is not a pet: no pet rent, pet fee, pet deposit, or breed or size restriction may attach to it, and it cannot be the subject of an unauthorized-animal notice. If this is a SECOND animal, say so in the observations — the approval names which animal it covers.',
  ask_first:
    'Before serving on an animal, ask whether it is a service or assistance animal. A tenant is not required to volunteer that, and a notice served on an assistance animal is a fair-housing complaint whether or not anybody had been told. If the answer is yes, log an accommodation request instead of serving.',
}

/**
 * What to put in front of somebody opening or escalating an
 * unauthorized-animal case.
 *
 * Warns; never blocks. An animal genuinely can be an unauthorized pet with an
 * unrelated accommodation request open on the same tenancy, and a product
 * that refused here would be making the judgement this file says it does not
 * make. What it will not allow is doing it without having been told.
 */
export function animalCaseFork(facts: {
  hasApprovedAssistanceAnimal: boolean
  hasUndecidedRequest: boolean
}): AnimalFork {
  if (facts.hasApprovedAssistanceAnimal) return 'already_approved'
  if (facts.hasUndecidedRequest) return 'request_undecided'
  return 'ask_first'
}

// ---------------------------------------------------------------------------
// Legitimization - the exit RISK-02 asks to be first-class
// ---------------------------------------------------------------------------

export interface LegitimizationRoute {
  available: boolean
  /// What the operator has to do before the case can close this way.
  steps: readonly string[]
  /// Present when `available` is false.
  refusal?: string
}

/**
 * How a case of each kind is brought within the lease.
 *
 * ==========================================================================
 * AN OCCUPANT IS LEGITIMIZED BY THE ORDINARY SCREENING PATH, WITH NO
 * SHORTCUT, AND THAT IS THE POINT OF PUTTING IT HERE.
 *
 * The tempting build is a "manager approves the occupant" button, because
 * the person is already living there and the paperwork feels like theatre.
 * It is not theatre. Applying a laxer standard to the occupant in front of
 * you than to the applicant on the phone is disparate treatment, and it is
 * disparate treatment recorded in your own system with a name and a date on
 * it. Somebody you would let live there is somebody you would have rented
 * to, judged against the same written criteria (`ScreeningCriteria`, R-060).
 *
 * A `PREMISES_CONDITION` case has no legitimize route at all. There is no
 * version of a blocked fire exit that becomes permitted by agreement, and
 * offering the option would invite exactly that agreement to be made. It is
 * cured, or accommodated, or it is still open.
 * ==========================================================================
 */
export const LEGITIMIZATION_ROUTES: Record<ViolationKind, LegitimizationRoute> = {
  UNAUTHORIZED_OCCUPANT: {
    available: true,
    steps: [
      'Have them complete an application, as any applicant would.',
      'Screen them against the current written criteria — the same ones, unchanged.',
      'Record the screening decision, then add them to the lease.',
    ],
  },
  UNAUTHORIZED_ANIMAL: {
    available: true,
    steps: [
      'Ask first whether it is a service or assistance animal. If it is, this is an accommodation request, not a pet authorization.',
      'Describe the animal being authorized well enough that a later dispute about which animal has an answer.',
      'Add any agreed pet rent through the recurring-charge path, which enforces the assistance-animal rule at the money.',
    ],
  },
  PREMISES_CONDITION: {
    available: false,
    steps: [],
    refusal:
      'A condition is not legitimized. A blocked exit does not become permitted by agreement, and offering that as an outcome is how the agreement gets made. Close it as cured when it is corrected, or as accommodated if an accommodation was approved instead.',
  },
}

// ---------------------------------------------------------------------------
// Closing a case
// ---------------------------------------------------------------------------

export interface ClosureFacts {
  kind: ViolationKind
  outcome: ViolationOutcome
  /// The account of how it ended. Required for every outcome.
  outcomeNote: string
  /// `Applicant.id` of the person screened and added, for an occupant
  /// legitimization. Null when there is none.
  legitimizedApplicantId: string | null
  /// True when that applicant has a recorded screening decision.
  legitimizedApplicantScreened: boolean
  /// Description of the animal being authorized, for an animal
  /// legitimization.
  authorizedAnimal: string | null
  /// An accommodation request on this tenancy that has been APPROVED.
  approvedAccommodationId: string | null
  /// An accommodation request on this tenancy still undecided.
  hasUndecidedRequest: boolean
  /// Free text the operator gave for proceeding despite a warning. Only ever
  /// consulted where a warning is raised.
  overrideReason: string | null
}

export interface ClosureDecision {
  violations: Violation[]
  /// Warnings do not stop the close; an unanswered one that needs a reason
  /// appears in `violations` instead, via `overrideReason`.
  warnings: string[]
}

/**
 * Whether this case may be closed the way it is being closed.
 *
 * ==========================================================================
 * ONE HARD REFUSAL, AND IT IS THE ANIMAL LEGITIMIZATION.
 *
 * Everything else here warns, in the posture D-79 sets out: serving,
 * escalating and closing are all sometimes the right act, and a product that
 * blocked them would push the operator into deleting the inconvenient record
 * instead - which is strictly worse than a warning they read.
 *
 * Recording an animal as an authorized PET while an accommodation request on
 * the same tenancy is undecided is different, for the reason D-85 gives about
 * the §3931 affidavit: the operator's workaround is not to destroy a record,
 * it is to go and decide the request - which was owed inside ten days anyway
 * (D-89) and takes an afternoon. "Authorized pet" is the finding that makes
 * pet money lawful; making it while the question of whether this is an
 * assistance animal is open pre-judges the request in the direction that
 * costs the tenant money.
 * ==========================================================================
 */
export function validateClosure(facts: ClosureFacts): ClosureDecision {
  const violations: Violation[] = []
  const warnings: string[] = []

  if (facts.outcomeNote.trim().length < 20) {
    violations.push({
      field: 'outcomeNote',
      message:
        'Say how this ended. A case marked closed with no account of how is the record that helps nobody eighteen months later, which is when it gets read.',
    })
  }

  if (facts.outcome === 'LEGITIMIZED') {
    const route = LEGITIMIZATION_ROUTES[facts.kind]
    if (!route.available) {
      violations.push({ field: 'outcome', message: route.refusal! })
    }

    if (facts.kind === 'UNAUTHORIZED_OCCUPANT') {
      if (!facts.legitimizedApplicantId) {
        violations.push({
          field: 'legitimizedApplicantId',
          message:
            'Name the application this went through. An occupant added without one was held to a different standard than the last person who applied for a unit here, and the record says so.',
        })
      } else if (!facts.legitimizedApplicantScreened) {
        violations.push({
          field: 'legitimizedApplicantId',
          message:
            'That application has no screening decision recorded. Screening against the current written criteria is the whole of what makes this equal treatment rather than a favour.',
        })
      }
    }

    if (facts.kind === 'UNAUTHORIZED_ANIMAL') {
      if ((facts.authorizedAnimal ?? '').trim().length < 3) {
        violations.push({
          field: 'authorizedAnimal',
          message: 'Describe the animal being authorized — species, and a name if there is one.',
        })
      }
      // The hard refusal. See this function's header.
      if (facts.hasUndecidedRequest) {
        violations.push({
          field: 'outcome',
          message:
            'There is an undecided accommodation request on this tenancy. Authorizing this animal as a pet answers that request in the direction that costs the tenant money, before it has been decided. Decide the request first — it has been owed since it arrived.',
        })
      }
    }
  }

  if (facts.outcome === 'ACCOMMODATED' && !facts.approvedAccommodationId) {
    violations.push({
      field: 'outcome',
      message:
        'No approved accommodation request is linked to this case. Closing as accommodated with nothing on file leaves the accommodation itself unprovable, which is the position the tenant is in when the next person reads the lease.',
    })
  }

  // The warning that needs a reason. Escalating to eviction while a request
  // sits undecided is the sequence a retaliation or failure-to-accommodate
  // claim is built from - and it is sometimes entirely lawful, which is why
  // it is a reason rather than a refusal.
  if (facts.outcome === 'ESCALATED' && facts.hasUndecidedRequest) {
    if ((facts.overrideReason ?? '').trim().length < 20) {
      violations.push({
        field: 'overrideReason',
        message:
          'An accommodation request on this tenancy is undecided, and you are escalating to eviction. That sequence is what a failure-to-accommodate claim is built from. It may still be the right call — say why, and decide the request either way.',
      })
    } else {
      warnings.push(
        'Escalated with an accommodation request still undecided. The request is still owed a written determination.',
      )
    }
  }

  if (facts.outcome === 'ESCALATED' && facts.approvedAccommodationId) {
    warnings.push(
      'This tenancy has an approved accommodation. Check that what is being escalated is not the conduct that accommodation covers.',
    )
  }

  return { violations, warnings }
}
