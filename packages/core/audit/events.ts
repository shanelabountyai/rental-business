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

  // Maintenance (MAINT-03, R-024)
  /// The scope, priority and estimate a work order was CREATED with -
  /// WorkOrder is mutated heavily afterward (status, assignment, actuals),
  /// so this is the one place the original creation survives verbatim, the
  /// same "audit the write too" call ticket.submitted already makes.
  'workorder.created',
  /// Who it was assigned to (staff or vendor) and when - MAINT-03's
  /// either/or assignment, recorded before dispatch could put anyone in a
  /// position to argue about it later.
  'workorder.assigned',
  /// Entered or left ON_HOLD_WARRANTY (PROP-06/MAINT-03's "warranty claim
  /// pending" state) - separate from workorder.assigned because it is a
  /// different fact (a claim was filed or resolved, not a person assigned).
  'workorder.warranty_hold_set',
  /// R-025: a vendor answered their magic link (accepted, declined,
  /// proposed a window) or marked the work complete. Recorded with
  /// actorType VENDOR, because the whole point of a zero-login link (D-6)
  /// is that an outside party acted on our system with no account behind
  /// them - "who said yes to this job, and when" has to be answerable
  /// afterwards from the trail alone.
  'workorder.vendor_responded',
  /// R-026: a work order went up for approval - either because its estimate
  /// cleared the entity's threshold and the requester's own ceiling did not
  /// cover it, or because actuals ran past what was approved. The `after`
  /// snapshot records WHY, including the requester's ceiling at that moment,
  /// because ceilings change and the reason would otherwise be
  /// unreconstructable.
  'workorder.approval_requested',
  /// R-026: an approver asked a question back instead of deciding. Recorded
  /// because "the owner was asked and this is what they wanted to know" is
  /// part of the same story as approving or denying, and a gap where the
  /// question was would read as unexplained delay.
  'workorder.approval_asked',
  /// R-026: a vendor answered a bid request with a price, or declined to
  /// bid. Recorded with actorType VENDOR for the same reason
  /// workorder.vendor_responded is - an outside party with no account acted
  /// on our system, and "who quoted what, and when" is the whole evidence
  /// base for choosing one of them.
  'workorder.bid_submitted',
  /// R-026: bids were requested from a set of vendors. One entry for the
  /// request, naming everyone asked, so "who was given the chance" survives
  /// even for the vendors who never replied.
  'workorder.bids_requested',
  /// R-025: a vendor link was sent (or resent). Recorded because it is the
  /// moment an access code became reachable by an outside party, and
  /// because resending revokes the previous link - the trail is how anyone
  /// later reconstructs which link was live when.
  'workorder.dispatched',

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
  /// R-014: a new code recorded for a unit (AccessCode's own version history
  /// is the change record; this is the evidence-trail entry alongside it,
  /// matching document.uploaded's "audit the write too, not only removal"
  /// call for the same reason - a re-key is exactly the kind of fact a
  /// later dispute asks "who did this and when" about).
  'accesscode.set',

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

  /// R-019: a tenant's maintenance request, at the moment they submitted it.
  /// Ticket itself is NOT append-only - status, priority and category get
  /// edited during triage (R-023) - so this is the one place the tenant's
  /// original submission (their category, prompt answers, and whether they
  /// tried the troubleshooting script) survives verbatim, the same "audit the
  /// write too, not only what happens to it later" call R-012 made for
  /// document.uploaded.
  'ticket.submitted',

  /// R-023: a triage decision - priority override, merge, "waiting on
  /// tenant", converted, or closed. Ticket rows are mutated in place (see
  /// ticket.submitted's own comment), so this is the before/after record of
  /// what triage changed and when - RISK-05's "response-time logging" is
  /// this entry plus Ticket.firstResponseAt, not a separate mechanism.
  'ticket.triaged',

  /// R-029: somebody took responsibility for an emergency page. The clock
  /// that NOTIF-05's escalation runs on stops here, so "who acknowledged, and
  /// how long after the tenant reported it" is a question the trail has to be
  /// able to answer - it is the response-time evidence for the one ticket
  /// class where response time is a safety matter rather than a service
  /// level.
  'ticket.acknowledged',

  /// R-029: nobody acknowledged in time and the chain fired. Recorded even
  /// though every page is already a Notification row, because this is the
  /// entry that says WHY a second set of people were woken up, and whether
  /// the rota was configured at all when it happened.
  'ticket.escalated',

  /// R-029: somebody changed who is on call, or the order the chain runs in.
  /// A rota that quietly narrowed to one unreachable person is a paging
  /// failure waiting to happen, and the trail should say who narrowed it.
  'staff.on_call_changed',

  /// R-029: a vendor was added to or removed from the after-hours list.
  'vendor.emergency_availability_changed',

  /// R-030: the work is finished and the tenant is being asked. A distinct
  /// action from `workorder.closed` because these are different claims by
  /// different people - "I have finished" from whoever did the work, and "I
  /// accept it and here is what it cost" from whoever closed it.
  'workorder.work_completed',

  /// R-030: the tenant answered "was this resolved?". Recorded as an audit
  /// entry as well as a WorkOrderVerification row because the row is the
  /// answer and this is the evidence of WHEN it was given and from where -
  /// which is what a disputed "you never told us it was still broken"
  /// actually turns on.
  'workorder.verified',

  /// R-030: a tenant's "no" sent the job back.
  'workorder.reopened',

  /// R-030: closed, with the cost that closed it. The last entry in the
  /// work order -> invoice -> books chain, and the one a later reconciliation
  /// reads to ask why a property's maintenance total is what it is.
  'workorder.closed',

  /// R-032 (COMM-06): a staff-only internal note on a work order. The note
  /// itself already lives in its own table; this is what lets "who added
  /// what, and when" show up in the SAME trail as every other privileged
  /// action, rather than requiring a second table to be checked.
  'workorder.note_added',

  /// R-032: an existing message - most often an inbound tenant text that
  /// arrived before anyone knew which job it was about - was tagged as
  /// evidence for this work order after the fact. Recorded because linking
  /// evidence to an incident is itself a decision worth a trail: it is a
  /// human saying "this is about that", not something the system inferred.
  'message.attached_to_workorder',

  /// R-033: a tenancy record was created. Carries `origin`, because an
  /// INHERITED lease and an APPLICATION one are different claims about what
  /// evidence exists behind the terms.
  'lease.created',

  /// R-033: the terms changed - rent, dates, deposit, utilities. The
  /// before/after pair is the whole point: "the rent was always $1,600" is
  /// a claim this entry either supports or refutes.
  'lease.updated',

  /// R-033: the lease moved through its lifecycle. A separate action from
  /// `lease.updated` because a status change has consequences an edit does
  /// not - a unit becomes occupied, rent starts being owed, a deposit clock
  /// eventually starts.
  'lease.status_changed',

  /// R-033: the tenancy was cut short - eviction, early termination,
  /// mutual release. Its OWN action rather than a `lease.status_changed`
  /// with a particular payload, so it can sit in REASON_REQUIRED: the
  /// writer itself then refuses to record a termination with no stated
  /// reason, which is the same call R-024 made splitting `workorder.denied`
  /// out from `workorder.approved`. A conditional "required only when the
  /// target is TERMINATED" is not something that set can express.
  'lease.terminated',

  /// R-033: notice to end the tenancy was recorded, by either side. The
  /// date this writes drives statutory clocks (R-062), so who gave it and
  /// exactly when are both on the entry.
  'lease.notice_given',

  /// R-033: somebody was added to or removed from the lease. Adding an
  /// occupant changes who is jointly liable and who can reach the portal;
  /// adding a guarantor changes who can be pursued and nothing else.
  'lease.party_changed',

  /// R-034 (D-11): a lease's Stripe Customer and Subscription were opened.
  /// Carries the provider name, because a record that does not say whether
  /// it was Stripe or the simulator is a record somebody will misread the
  /// first time a staging database is mistaken for production.
  'billing.provisioned',

  /// R-034: a Stripe webhook was projected into the ledger. The event id is
  /// on the entry itself; this is the trail of what the PIPELINE did,
  /// including the events it deliberately ignored.
  'billing.event_projected',

  /// R-033 (RISK-08): an inherited tenancy's outstanding items moved - the
  /// tenant confirmed the terms, or the deposit position was established.
  /// Recorded because each is a fact somebody asserted on a date, and at
  /// move-out the date is what a dispute turns on.
  'lease.intake_resolved',
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
  'lease.terminated',
])

export function requiresReason(action: AuditAction): boolean {
  return REASON_REQUIRED.has(action)
}
