// The domain-event vocabulary. Closed, for the same reason audit actions and
// permissions are: free-text event names produce `lease.ended`, `LeaseEnded`
// and `lease_end` in the same table within a year, and then no consumer can be
// sure it is subscribed to everything it should be.
//
// An event is a statement of FACT, in the past tense: something happened, and
// whoever cares can react. It is never a command - `lease.ended` belongs here,
// `send_move_out_email` does not. That distinction is what lets a consumer be
// added later without the emitter knowing about it, which is the whole reason
// for an event bus in a product where R-030's notification engine, R-011's task
// queue and the ledger projection all need to react to the same handful of
// facts.

export const DOMAIN_EVENTS = [
  // Tenancy
  'lease.activated',
  'lease.ended',
  'lease.renewed',
  'lease.notice_given',
  'tenant.moved_in',
  'tenant.moved_out',

  // Money. D-11 keeps Stripe as the system of record, so these announce what
  // the projection observed, never what the product decided to charge.
  'charge.posted',
  'payment.settled',
  'payment.failed',
  'payment.reversed',
  'lease.went_delinquent',
  'late_fee.assessed',
  'deposit.disposition_due',

  // Maintenance
  'ticket.created',
  'ticket.escalated',
  'workorder.created',
  'workorder.assigned',
  'workorder.completed',
  'workorder.approval_needed',

  // Evidence and compliance
  'notice.served',
  'inspection.completed',
  'compliance.due_soon',

  // Scheduling. Emitted by the runner itself so a job that wants to fan out
  // per property does not have to re-derive the local date.
  'day.rolled_over',

  /// A lease ended without a renewal in place, so R-009's nightly job flipped
  /// the unit to MAKE_READY (PROP-02). The natural trigger for a turnover
  /// checklist (R-011's task queue, once it exists) or a "unit needs prep"
  /// notification (R-030) - neither consumer exists yet; this is the fact
  /// they will subscribe to.
  'unit.became_make_ready',
] as const

export type DomainEvent = (typeof DOMAIN_EVENTS)[number]

const EVENT_SET: ReadonlySet<string> = new Set(DOMAIN_EVENTS)

/**
 * What an emitter provides. `aggregate` names the record the event is about so
 * a consumer can load the current state rather than trusting a payload that
 * may be minutes stale by the time it is delivered.
 *
 * Payloads stay small and are treated as a hint, not a source of truth: an
 * at-least-once bus that carries a full record snapshot eventually delivers a
 * stale one to a consumer that acts on it.
 */
export interface EventEnvelope {
  type: DomainEvent
  aggregateType: string
  aggregateId: string
  propertyId?: string | null
  payload?: Record<string, unknown>
  occurredAt?: Date
}
