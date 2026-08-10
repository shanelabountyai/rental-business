// The lease lifecycle (LEASE-06, R-033). Pure - no database, no Next.js.
//
// WHY A GUARDED MACHINE RATHER THAN A STATUS COLUMN ANYBODY CAN SET.
// Everything downstream of this item keys on lease status: R-034 opens a
// Stripe subscription when a lease activates, R-035 posts rent against a
// lease in force, R-062 computes notice periods, R-071 starts a deposit
// disposition clock at move-out. A status that can move anywhere from
// anywhere means each of those has to defend itself against states that
// should have been impossible. Naming the legal transitions once, here,
// is what keeps that from being fourteen separate problems.

/// Deliberately mirrors the Prisma enum rather than importing it - see
/// packages/core/notifications/categories.ts for the same call and the
/// bundle-weight reason behind it. The `satisfies` in the app layer is what
/// keeps the two from drifting.
export const LEASE_STATUSES = [
  'DRAFT',
  'PENDING_SIGNATURE',
  'ACTIVE',
  'MONTH_TO_MONTH',
  'ENDED',
  'TERMINATED',
] as const
export type LeaseStatusValue = (typeof LEASE_STATUSES)[number]

/// A tenancy that is running: rent is due, repairs are owed, entry notice
/// applies. The single definition every other module should ask rather than
/// re-listing statuses and getting it subtly different.
const IN_FORCE: ReadonlySet<LeaseStatusValue> = new Set(['ACTIVE', 'MONTH_TO_MONTH'])

export function leaseIsInForce(status: string): boolean {
  return IN_FORCE.has(status as LeaseStatusValue)
}

/// Over, one way or another. Nothing further happens to it.
const FINAL: ReadonlySet<LeaseStatusValue> = new Set(['ENDED', 'TERMINATED'])

export function leaseIsOver(status: string): boolean {
  return FINAL.has(status as LeaseStatusValue)
}

/**
 * Every legal move, and nothing else.
 *
 * Worth reading as a list of what is NOT here:
 *
 *   - Nothing leaves ENDED or TERMINATED. A tenancy that restarts is a NEW
 *     lease, not the old one reopened - the old one's dates, rent and
 *     signatures are evidence, and editing them to mean something else
 *     destroys the record R-071's deposit disposition is defended with.
 *   - ACTIVE never goes back to DRAFT. A lease signed and started cannot be
 *     un-started; correcting a mistake means terminating it and recording
 *     why, which is what actually happened.
 *   - MONTH_TO_MONTH does not return to ACTIVE. Rolling over is one-way;
 *     agreeing a new fixed term is a new lease (LEASE-09's renewal).
 */
const TRANSITIONS: Readonly<Record<LeaseStatusValue, readonly LeaseStatusValue[]>> = {
  DRAFT: ['PENDING_SIGNATURE', 'ACTIVE', 'TERMINATED'],
  // Straight to ACTIVE from DRAFT is deliberate and is the inherited path
  // (RISK-08): there is nothing to sign, because the signing happened years
  // ago with somebody else. R-063's e-sign flow uses the longer route.
  PENDING_SIGNATURE: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['MONTH_TO_MONTH', 'ENDED', 'TERMINATED'],
  MONTH_TO_MONTH: ['ENDED', 'TERMINATED'],
  ENDED: [],
  TERMINATED: [],
}

export type TransitionRefusal =
  /// The move is not in the machine at all.
  | 'illegal_transition'
  /// It is already there. Not an error worth shouting about, but not a
  /// write either.
  | 'already_there'
  /// TERMINATED demands a stated reason (see the enum's own comment).
  | 'reason_required'
  /// A lease cannot go live without the things that make it a lease.
  | 'incomplete'

export interface TransitionDecision {
  allowed: boolean
  refusal?: TransitionRefusal
  /// What to tell a human. Written as a sentence saying what is wrong AND
  /// what to do, because a form that only says no is one somebody works
  /// around.
  message?: string
}

export interface LeaseFacts {
  status: string
  /// Every adult on the lease. A tenancy with nobody on it is a
  /// bookkeeping artifact, not a tenancy.
  tenantCount: number
  rentCents: number
  startsOn: Date
  endsOn: Date | null
  isMonthToMonth: boolean
}

/**
 * Whether this lease may move to `to`.
 *
 * `reason` is only consulted for TERMINATED; every other transition ignores
 * it. Activation additionally checks the lease is actually complete - see
 * `activationGaps`.
 */
export function leaseTransition(
  facts: LeaseFacts,
  to: LeaseStatusValue,
  reason?: string | null,
): TransitionDecision {
  const from = facts.status as LeaseStatusValue

  if (from === to) {
    return { allowed: false, refusal: 'already_there', message: `This lease is already ${LABELS[to]}.` }
  }

  const legal = TRANSITIONS[from]
  if (!legal || !legal.includes(to)) {
    return {
      allowed: false,
      refusal: 'illegal_transition',
      message: leaseIsOver(from)
        ? `This lease is ${LABELS[from]} and cannot be changed. A tenancy that restarts is a new lease.`
        : `A ${LABELS[from]} lease cannot become ${LABELS[to]}.`,
    }
  }

  if (to === 'TERMINATED' && !reason?.trim()) {
    return {
      allowed: false,
      refusal: 'reason_required',
      message: 'Say why this tenancy was cut short — "ended" and "we had to end it" are different facts on the record.',
    }
  }

  if (to === 'ACTIVE') {
    const gaps = activationGaps(facts)
    if (gaps.length > 0) {
      return {
        allowed: false,
        refusal: 'incomplete',
        message: `This lease is not ready to go live: ${gaps.join('; ')}.`,
      }
    }
  }

  return { allowed: true }
}

/**
 * What is missing before a lease can go live.
 *
 * Returned as a list rather than a first-failure, so somebody fixing a
 * half-entered lease is told everything at once instead of discovering the
 * next problem after each save.
 */
export function activationGaps(facts: LeaseFacts): string[] {
  const gaps: string[] = []
  if (facts.tenantCount < 1) gaps.push('nobody is on it yet')
  if (!Number.isInteger(facts.rentCents) || facts.rentCents < 0) {
    gaps.push('the rent is not a whole-dollar amount')
  }
  // A fixed-term lease needs an end date; a month-to-month one must not
  // have one. Both directions matter: an open-ended "fixed term" never
  // triggers LEASE-09's renewal flags, and an MTM lease carrying an end
  // date would be auto-made-ready out from under a tenant who is still
  // living there (R-009's job keys on exactly that column).
  if (!facts.isMonthToMonth && !facts.endsOn) {
    gaps.push('a fixed-term lease needs an end date')
  }
  if (facts.isMonthToMonth && facts.endsOn) {
    gaps.push('a month-to-month lease should not have an end date')
  }
  if (facts.endsOn && facts.endsOn <= facts.startsOn) {
    gaps.push('it ends before it starts')
  }
  return gaps
}

const LABELS: Record<LeaseStatusValue, string> = {
  DRAFT: 'draft',
  PENDING_SIGNATURE: 'awaiting signature',
  ACTIVE: 'active',
  MONTH_TO_MONTH: 'month-to-month',
  ENDED: 'ended',
  TERMINATED: 'terminated',
}

export function leaseStatusLabel(status: string): string {
  return LABELS[status as LeaseStatusValue] ?? status
}

export const NOTICE_PARTIES = ['TENANT', 'LANDLORD'] as const
export type NoticePartyValue = (typeof NOTICE_PARTIES)[number]

/**
 * Whether notice to end the tenancy can be recorded.
 *
 * Only against a lease in force. Notice on a draft is meaningless, and
 * notice on a lease that already ended is somebody filing paperwork against
 * the wrong tenancy - which is worth refusing rather than silently
 * accepting, because the date it writes drives statutory clocks later.
 */
export function canGiveNotice(facts: {
  status: string
  noticeGivenAt: Date | null
}): TransitionDecision {
  if (!leaseIsInForce(facts.status)) {
    return {
      allowed: false,
      refusal: 'illegal_transition',
      message: 'Notice can only be given on a tenancy that is running.',
    }
  }
  if (facts.noticeGivenAt) {
    return {
      allowed: false,
      refusal: 'already_there',
      message: 'Notice has already been recorded on this tenancy.',
    }
  }
  return { allowed: true }
}
