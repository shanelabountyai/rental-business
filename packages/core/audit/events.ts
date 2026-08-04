// The audit vocabulary: what can be recorded, and which entries demand a
// stated reason.
//
// ROLE-03 names the privileged actions that must be logged - ledger
// adjustment, waiver, approval, permission change, document deletion-marking,
// screening decision, code reveal - and R-004 already gates each of those
// behind a permission that requires MFA. The two lists are meant to stay in
// step, and `audit.test.ts` asserts they do.
//
// Actions are a closed vocabulary for the same reason permissions are: a
// free-text action string produces `lease.updated`, `lease.update` and
// `updateLease` in the same table within a year, and then nobody can answer
// "show me every change to this lease" without a regex.

export const AUDIT_ACTIONS = [
  // Ownership & inventory (R-008)
  'legal_entity.created',
  'legal_entity.updated',
  'property.created',
  'property.updated',
  'unit.created',
  'unit.updated',
  /// The one AUTOMATED unit mutation (PROP-02): a lease ended without a
  /// renewal in place, so R-009's nightly job flipped the unit to
  /// MAKE_READY. Attributed to SYSTEM, not a staff member.
  'unit.auto_made_ready',

  // Access and identity
  'auth.signed_in',
  'auth.locked_out',
  'auth.password_reset',
  'auth.mfa_enrolled',
  'auth.sessions_revoked',

  // Permission changes (ROLE-03)
  'staff.assignment_granted',
  'staff.assignment_revoked',
  'staff.deactivated',
  'staff.reactivated',
  'staff.ceiling_changed',

  // Money (ROLE-03, PAY-04)
  'ledger.adjusted',
  'fee.waived',
  'payment.recorded',
  'payment.reversed',

  // Maintenance (MAINT-04)
  'workorder.approved',
  'workorder.denied',
  'workorder.chargeback_posted',

  // Evidence
  /// R-012: every upload, not just deletion - a document IS evidence, and
  /// "who added this and when" is as much chain-of-custody as "who removed
  /// it". Unlike R-011's Task, which deliberately does not audit creation.
  'document.uploaded',
  'document.delete_marked',
  'document.restored',
  'notice.served',
  'inspection.locked',

  /// PROP-03: "Given access codes, when an external vendor views a work
  /// order, then codes are revealed per-work-order only and each reveal is
  /// logged." A vendor seeing a lockbox code is a privileged READ, which is
  /// unusual enough to be worth saying out loud - most audit logs only record
  /// writes, and this one would miss the event that matters most in a
  /// break-in dispute.
  'accesscode.revealed',

  /// Scheduled work that did not complete (R-006). Recorded rather than only
  /// logged, because a nightly job failing silently is how a month of missing
  /// late fees happens - and AuditLog is still there when someone finally asks.
  'job.failed',

  // Compliance overrides
  'entry_notice.overridden',
  'screening.decided',
  'application_order.deviated',

  /// R-010: a new effective-dated version of a JurisdictionRule. The one
  /// mutation this entity gets - versions are added, never edited in place
  /// (D-4), so there is no separate "updated" action.
  'jurisdiction_rule.versioned',

  /// R-011 (D-9): resolution (completed or canceled) of a task whose TYPE is
  /// in AUDITED_TASK_TYPES - not every task, just the ones a later item marks
  /// as needing to show up in the evidence trail on top of the Task row's own
  /// completedByStaffId/completedAt.
  'task.completed',
  'task.canceled',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS)

export function isAuditAction(value: string): value is AuditAction {
  return ACTION_SET.has(value)
}

/**
 * Reason codes. A closed set, because "reason" as free text alone cannot be
 * reported on - and PAY-04 wants a waiver-pattern report by tenant for fair
 * housing consistency, which needs a category, not a paragraph.
 *
 * Both are stored: the code for counting, the free text for explaining.
 */
export const REASON_CODES = [
  'goodwill',
  'first_occurrence',
  'billing_error',
  'payment_plan',
  'hardship',
  'duplicate',
  'owner_directive',
  'legal_advice',
  'emergency',
  'tenant_request',
  'correction',
  'other',
] as const

export type ReasonCode = (typeof REASON_CODES)[number]

const REASON_SET: ReadonlySet<string> = new Set(REASON_CODES)

export function isReasonCode(value: string): value is ReasonCode {
  return REASON_SET.has(value)
}

/**
 * Actions that cannot be recorded without a reason.
 *
 * These are the ones where "why" is the whole point of the record. A waived
 * late fee with no stated reason is indistinguishable from a favour, and
 * PAY-04 asks for exactly that report; an entry-notice override with no reason
 * is the fact pattern in an unlawful-entry claim.
 *
 * Enforced in recordAudit(), which throws rather than writing an entry that
 * would be useless in the dispute it exists for.
 */
export const REASON_REQUIRED: ReadonlySet<AuditAction> = new Set([
  'ledger.adjusted',
  'fee.waived',
  'payment.reversed',
  'workorder.denied',
  'document.delete_marked',
  'entry_notice.overridden',
  'application_order.deviated',
])

export function requiresReason(action: AuditAction): boolean {
  return REASON_REQUIRED.has(action)
}
