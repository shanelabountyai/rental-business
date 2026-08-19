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

  // Listings (LEASE-01, R-056)
  'listing.created',
  'listing.updated',
  /// The moment a listing becomes a page anyone can reach. Its own action,
  /// not folded into `listing.updated`, because "when did this go public"
  /// is a different question than "what changed" and both get asked.
  'listing.published',
  'listing.unpublished',

  // Prospect pipeline (LEASE-07, R-058)
  'prospect.created',
  /// A prospect answered the five fixed pre-screening questions. Its own
  /// action rather than folded into a generic update, matching
  /// `listing.published`'s own reasoning: "when did this happen" is a
  /// question worth answering on its own.
  'prospect.prescreened',
  /// A staff member moved a prospect along the pipeline by hand (SHOWING,
  /// APPLIED, SCREENED, APPROVED, SIGNED) - the downstream stages nothing
  /// in this build yet drives automatically. Its own action, not
  /// `prospect.updated`, for the same reason `lease.status_changed` is
  /// separate from a plain field edit: a stage move is a business decision
  /// worth its own row, distinct from correcting a typo in a name.
  'prospect.stage_changed',

  // Application pipeline (LEASE-03, R-059)
  /// Staff invited a prospect to apply - creates the Application group and
  /// its lead Applicant in one action.
  'application.invited',
  /// The lead added a co-applicant, who gets their own APPLICATION_LINK.
  'application.coapplicant_added',
  /// One applicant's own form section was saved (may still be incomplete -
  /// see the field-level violations, not this row, for whether it validated
  /// clean; this fires on every save so partial progress is provable too).
  'application.applicant_saved',
  /// One applicant's fee cleared. Written from the Stripe webhook, never
  /// from the form submit - D-11's rule that the ledger (and here, a fee
  /// fact) moves only on confirmation, not on intent.
  'application.fee_paid',
  /// Every Applicant under the group is done (form complete, fee cleared or
  /// none due) - the "completion timestamp" the backlog names for R-060 to
  /// order applications by.
  'application.completed',

  // Screening (LEASE-04, R-060)
  /// A consumer report was ordered from the (simulated) provider for one
  /// applicant, triggered automatically once their household's application
  /// completed - attributed to SYSTEM, the same posture 'unit.auto_made_ready'
  /// already gives an automated write.
  'screening.ordered',

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
  /// R-037: a tenant asked to pay, and what they were charged for the
  /// privilege. Recorded at the INTENT, not the outcome - whether the money
  /// arrives is Stripe's to tell us by webhook (D-11) - because the card fee
  /// is the part somebody disputes, and "what were we told it would cost"
  /// has to be answerable from the trail rather than recomputed later
  /// against a jurisdiction rule that may since have been re-versioned.
  'payment.intent_created',
  /// R-037: somebody moved a payer between autopay and invoiced collection
  /// (D-29). A privileged change to how money is taken from a tenant, and
  /// the reason is recorded with it.
  'payment.collection_method_changed',
  /// R-047 (PAY-12): a legal-action payment hold was placed or lifted. On
  /// REASON_REQUIRED, because "we stopped taking this tenant's money" is
  /// the fact an eviction is later argued from - and because a hold placed
  /// for no recorded reason is indistinguishable from one placed for a
  /// retaliatory one, which is the claim it will be defended against.
  'payment.hold_changed',
  /// R-047: a tenant tried to pay and the hold refused them. PAY-12 asks
  /// for exactly this - "the attempt is logged to the case file" - because
  /// an eviction turning on "they never tried to pay" must be arguable
  /// against a record of every time they did.
  'payment.hold_refused',

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
  /// R-062 (DOC-04): a PDF produced from a `DocumentTemplate` and archived,
  /// separate from `document.uploaded` because nobody uploaded a file -
  /// this product generated one, from a template a PM wrote and a merge
  /// field it filled in.
  'document.generated',
  'notice.served',
  /// R-051: the notice PDF was rendered and archived as a Document. Separate
  /// from `notice.served` because generating the artifact and serving it are
  /// different acts that can happen minutes or days apart - and because the
  /// question "is what we posted on the door the same file we still hold" is
  /// answered by this row plus the Document's sha256, not by the serving.
  'notice.generated',
  /// R-051: a tenant opened a notice served through the portal. A privileged
  /// READ recorded deliberately, like `accesscode.revealed` above - for
  /// PORTAL service this event IS the proof of delivery, and it is the only
  /// evidence that the notice reached anybody at all.
  'notice.read',
  /// R-051b: a tenant's agreement to be contacted was recorded, with the
  /// basis it rests on. The evidence a TCPA claim is defended with - damages
  /// there are statutory and per-message, so "who asserted this consent
  /// existed, and when" is the whole question.
  'consent.recorded',
  /// R-051b: consent withdrawn. On REASON_REQUIRED below, because "why did we
  /// stop being allowed to text them" is what a dispute turns on, and a
  /// withdrawal with no stated reason is indistinguishable from a misclick.
  'consent.withdrawn',

  // Inspection engine (INSP-01, R-068).
  /// A new inspection was started, from a template or ad hoc - which
  /// template (if any) and the room/item list it copied are on the entry,
  /// because a template can be edited later and this is the record of what
  /// this inspection actually started from.
  'inspection.created',
  /// The walk was marked performed - every checklist item now carries a
  /// recorded condition. Item-by-item edits before this point are not
  /// individually audited (a correction while still walking is not itself
  /// evidence of anything); this is the fact the report's own conclusions
  /// rest on.
  'inspection.performed',
  /// R-068 phase 2: somebody signed - the tenant, from the portal, or a
  /// staff member recording that they signed in person. Its own action,
  /// not folded into `inspection.locked`, because "who signed and when" is
  /// the fact an authenticity dispute over the signature itself turns on,
  /// the same reasoning `envelope.signer_signed` already gives a lease
  /// e-signature (R-063) - `actorType` on this row is what tells the two
  /// paths apart (TENANT vs STAFF).
  'inspection.signed',
  /// Locked - the report becomes immutable evidence. Stubbed here since
  /// before R-068, unused until now.
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
  /// R-061: staff moved a prospect to APPROVED/SIGNED despite an unsent
  /// FCRA adverse-action notice - "blocks closing the application until
  /// sent or overridden with a logged reason" (LEASE-05). Its own action
  /// rather than a flag on `prospect.stage_changed`, the same call
  /// `entry_notice.overridden` already made for `workorder`'s stage change:
  /// REASON_REQUIRED cannot express "required only when a notice is owed".
  'adverse_action.overridden',

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

  /// R-049: a managed message template was created or edited. Templates are
  /// not evidence themselves, but a message sent from one is - and "what did
  /// this template say on the day it went out" is unanswerable from a row
  /// that has since been edited.
  /// R-044: one press sent a templated reminder to a selection of tenancies.
  /// Records what was REQUESTED, what was sent, and every skip with its
  /// reason - "why did this tenant not get the reminder we sent everybody"
  /// is the question asked three weeks later, and a bare count cannot
  /// answer it.
  'message.bulk_sent',
  /// R-053 (COMM-04): a segment announcement went out — all tenants, one
  /// property, one metro or one tag. Same reasoning as `message.bulk_sent`:
  /// records what segment was targeted, what was requested, what was sent,
  /// and every skip with its reason.
  'message.announcement_sent',
  /// R-052 (COMM-05): a communications transcript was produced for a party -
  /// every message, notification and served notice on their record, in one
  /// PDF that leaves the building.
  ///
  /// THE EXPORT IS THE PRIVILEGED ACT, not the reading. Nothing here is new
  /// information to the staff member who ran it; what changed is that a
  /// tenant's entire communications history now exists as a file somebody can
  /// forward. That is the moment worth a trail - who took it, when, for which
  /// party, and how many entries it contained, so a later dispute about what
  /// was disclosed can be answered against a record rather than a memory.
  'comms.transcript_exported',
  /// R-052 (PAY-09): a statement of account was produced for a lease and
  /// period, with the payment processor's invoices appended (D-50). Records
  /// the window and the closing balance, because a statement handed to a
  /// court is a claim about what was owed on a date, and which claim we made
  /// has to survive the ledger continuing to move afterwards.
  'ledger.statement_exported',
  'template.saved',
  /// R-049: a translation was marked approved for a LEGAL notice. THE most
  /// consequential row in this area. The product cannot verify an attorney
  /// read it; it can only record who claimed so, and this is that record.
  /// On REASON_REQUIRED, because "approved by whom, on what basis" is the
  /// entire question in a dispute over a mistranslated notice.
  'template.translation_approved',

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

  /// R-055 (RISK-06, D-4): a rent increase or a landlord's own notice went
  /// ahead despite falling inside the property's retaliation-presumption
  /// window. Its OWN action, deliberately not a flag on `lease.updated` or
  /// `lease.notice_given` - same reasoning as `lease.terminated`'s own
  /// comment: REASON_REQUIRED cannot express "required only when a warning
  /// applied", and this row is the one a retaliation defense stands or
  /// falls on, so it has to exist whichever action triggered it.
  'lease.retaliation_window_acknowledged',

  /// R-066 (LEASE-11, D-4): notice to end the tenancy - by either party -
  /// gave less than the jurisdiction's configured `noticeToVacateDays`, and
  /// it was recorded anyway. Its OWN action, same reasoning
  /// `lease.renewal_rent_check_overridden` already gives the identical
  /// shortfall shape on a rent increase instead of an end-of-tenancy date:
  /// REASON_REQUIRED cannot express "required only when short", and this is
  /// the row a short-notice non-renewal is defended with.
  'lease.notice_period_overridden',

  /// R-033: somebody was added to or removed from the lease. Adding an
  /// occupant changes who is jointly liable and who can reach the portal;
  /// adding a guarantor changes who can be pursued and nothing else.
  'lease.party_changed',

  /// R-065 (LEASE-09): a renewal offer created a successor DRAFT lease -
  /// `renewedFromLeaseId` names which lease it replaces. The rent proposed,
  /// the check that ran against it, and who drew it up are all on the entry.
  'lease.renewal_offered',

  /// R-065: a renewal offer's proposed rent gave less than the property's
  /// configured notice period, and staff proceeded anyway. Its OWN action,
  /// same reasoning `lease.retaliation_window_acknowledged` and
  /// `entry_notice.overridden` already give: REASON_REQUIRED cannot express
  /// "required only when the warning fired", and this is the row a
  /// short-notice increase is defended with. There is no equivalent action
  /// for a CAPPED rent - that basis blocks with no override, so nothing is
  /// ever written for it to acknowledge.
  'lease.renewal_rent_check_overridden',

  /// R-065: the effective-date cutover activated a signed renewal successor
  /// lease and ended the one it replaces, in the same transaction. Separate
  /// from `lease.status_changed` because two Lease rows change status at
  /// once here and a reader needs both without inferring the link from
  /// matching dates.
  'lease.renewed',

  /// R-065: a fixed-term lease reached its end date with no successor lease
  /// in flight, and rolled itself to MONTH_TO_MONTH at the configured MTM
  /// rate with no staff action - LEASE-09's "MTM rollover applying the
  /// configured rate automatically".
  'lease.rolled_to_month_to_month',

  /// R-067 (LEASE-10): a tenant's renter's-insurance certificate was
  /// recorded against a lease - carrier, policy number, expiry and the
  /// archived certificate itself.
  'lease.renter_insurance_recorded',

  /// R-063 (LEASE-06, DOC-02): a lease's document was generated and sent for
  /// e-signature - the base template, the addenda selected, and every
  /// signer named. Carries the provider name, matching `billing.provisioned`'s
  /// own reasoning for why that matters on a simulated-vs-real distinction.
  'envelope.sent',

  /// R-063: one signer completed their electronic signature. Its own action
  /// per signer, not a single `envelope.completed` - "who signed and when"
  /// is the fact an identity dispute over ONE signature turns on, and a
  /// completion event alone could not answer it for a multi-signer lease.
  'envelope.signer_signed',

  /// R-063: every signer has signed. The lease's own `lease.status_changed`
  /// (DRAFT/PENDING_SIGNATURE → ACTIVE) fires alongside this in the same
  /// transaction, matching how `billing.provisioned` sits beside a status
  /// change rather than replacing it.
  'envelope.completed',

  /// R-063: a sent-but-unsigned envelope was abandoned so the lease could be
  /// regenerated - REASON_REQUIRED, the same call `lease.terminated` makes:
  /// "we changed our minds" and "the tenant wants a term changed" are
  /// different claims about why a legal document was withdrawn.
  'envelope.voided',

  /// R-034 (D-11): a lease's Stripe Customer and Subscription were opened.
  /// Carries the provider name, because a record that does not say whether
  /// it was Stripe or the simulator is a record somebody will misread the
  /// first time a staging database is mistaken for production.
  'billing.provisioned',

  /// R-036 (D-11): the lifecycle sweep made Stripe agree with a lease -
  /// provisioned, re-priced, paused, resumed or cancelled. Carries the
  /// provider name for the same reason `billing.provisioned` does.
  'billing.subscription_synced',

  /// R-035 (D-11): the nightly reconciliation found the ledger projection
  /// and the processed-event log disagreeing. Recorded rather than only
  /// logged, and recorded in the append-only trail specifically: a
  /// projection that has drifted cannot be quietly corrected - the fix is a
  /// reversing entry somebody has to decide on - so the discrepancy needs
  /// the same permanence as the rows it is about.
  'ledger.drift_detected',

  /// R-042 (PAY-08): a recurring charge beside the rent - pet rent, a flat
  /// utility fee - started or stopped billing on the subscription. Both
  /// halves are recorded because both are money: the start is a term somebody
  /// agreed, and the stop is the answer to "you kept charging me for a dog
  /// that moved out in March".
  'billing.recurring_started',
  'billing.recurring_ended',

  /// R-042 (PAY-08): a utility bill was split across units and charged on
  /// (RUBS). Carries the bill total, the method, the weights and the split,
  /// because the whole defence of a RUBS charge is being able to show the
  /// arithmetic against the bill it came from - and several states regulate
  /// it, which is why `JurisdictionRule.rubsPermitted` gates it at all.
  'billing.rubs_allocated',

  /// R-034: a Stripe webhook was projected into the ledger. The event id is
  /// on the entry itself; this is the trail of what the PIPELINE did,
  /// including the events it deliberately ignored.
  'billing.event_projected',

  /// R-033 (RISK-08): an inherited tenancy's outstanding items moved - the
  /// tenant confirmed the terms, or the deposit position was established.
  /// Recorded because each is a fact somebody asserted on a date, and at
  /// move-out the date is what a dispute turns on.
  'lease.intake_resolved',

  /// R-040e: a phone number stopped accepting our SMS, or started again.
  ///
  /// SYSTEM-actor events by construction - nobody on our side decides these.
  /// The recipient texted STOP, or the carrier told us a send was blocked on
  /// their behalf. They are audited rather than merely stored because an
  /// opt-out silently overrides `LOCKED_CATEGORIES`: the product refuses to
  /// let a tenant switch off `entry_notice`, and a carrier STOP switches it
  /// off anyway. When somebody later asks why a legally significant notice
  /// was not delivered on a given date, this is the row that answers it.
  'notification.opted_out',
  'notification.opted_in',

  /// R-064: a prospect self-booked a showing slot. SYSTEM-actor by
  /// construction - the booking action is public and session-less, the same
  /// reasoning `prospect.prescreened` already gives.
  'showing.booked',

  /// R-064: staff withdrew a booked showing. No REASON_REQUIRED - unlike an
  /// entry-notice override or a voided envelope, there is no dispute a
  /// cancelled showing could later be litigated over, so this stays the
  /// same shape as `task.canceled` rather than `envelope.voided`.
  'showing.canceled',
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
  // R-031. Billing a tenant for a repair is a judgement — that this damage
  // was theirs, and that this share of the cost is fair. A chargeback with no
  // stated reason is indistinguishable from retaliation, which is the exact
  // claim it will be defended against, and the tenant's own notice reproduces
  // this reason verbatim.
  'workorder.chargeback_posted',
  'fee.waived',
  'payment.reversed',
  'workorder.denied',
  // R-049. "Approved by whom, on what basis" is the entire question in a
  // dispute over a mistranslated notice, and the product cannot verify an
  // attorney read it — only record who claimed so, and why.
  'template.translation_approved',
  'document.delete_marked',
  'entry_notice.overridden',
  'application_order.deviated',
  'adverse_action.overridden',
  'lease.terminated',
  'payment.hold_changed',
  'consent.withdrawn',
  'lease.retaliation_window_acknowledged',
  'lease.renewal_rent_check_overridden',
  'lease.notice_period_overridden',
  'envelope.voided',
])

export function requiresReason(action: AuditAction): boolean {
  return REASON_REQUIRED.has(action)
}
