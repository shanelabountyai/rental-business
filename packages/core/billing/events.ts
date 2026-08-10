// Stripe event → projection intent (R-034, D-11). Pure - no database, no SDK.
//
// D-11: "our `LedgerEntry` table becomes an APPEND-ONLY PROJECTION built from
// Stripe webhooks - still the audit surface, still exportable, but it no
// longer originates charges. A row here that Stripe does not know about is a
// reconciliation bug, not a shortcut."
//
// This module reads a Stripe event and says what it MEANS. It deliberately
// does not write anything: the app layer owns resolving Stripe ids to our
// lease and payer, and owns the transaction. Keeping the interpretation pure
// is what lets every event shape be tested against a fixture without a
// database or a Stripe account - and the interpretation is where the
// mistakes are, not the INSERT.

/**
 * The events this pipeline handles.
 *
 * Deliberately a CLOSED list, and deliberately short. Stripe emits well over
 * a hundred event types; a handler that tried to interpret all of them would
 * be mostly untested code reacting to things nobody has thought about. An
 * unrecognised event is acknowledged and recorded as ignored - never
 * retried, never treated as a failure - so Stripe's dashboard stays clean
 * and the log still shows what arrived.
 *
 * What is NOT here is as deliberate as what is:
 *   - `invoice.created` / `invoice.finalized` - an invoice that exists but
 *     has not been paid or failed changes nothing about what is owed that
 *     `invoice.payment_succeeded` will not say more precisely later.
 *   - `charge.*` - the same money as the invoice events, one layer down.
 *     Projecting both would double-count every payment.
 *   - `customer.subscription.*` - R-036 owns the subscription lifecycle.
 */
export const HANDLED_EVENTS = [
  /// Money arrived and the invoice is settled. The single most important
  /// event in the product.
  'invoice.payment_succeeded',
  /// A charge attempt failed - a declined card, a returned ACH. Records the
  /// failure; does NOT reverse anything, because the charge is still owed.
  'invoice.payment_failed',
  /// Money went back. A refund, or an ACH return after settlement.
  'charge.refunded',
  /// A dispute. Recorded so it is visible; the money movement itself
  /// arrives as its own balance transaction later.
  'charge.dispute.created',
] as const
export type HandledEvent = (typeof HANDLED_EVENTS)[number]

const HANDLED: ReadonlySet<string> = new Set(HANDLED_EVENTS)

export function isHandledEvent(type: string): type is HandledEvent {
  return HANDLED.has(type)
}

/// The subset of a Stripe event this pipeline reads. Structural rather than
/// imported from the SDK: nothing here needs the whole type, and depending
/// on a package version's shape for a JSON payload we receive over HTTP
/// would couple the interpretation to an SDK upgrade.
export interface StripeEventEnvelope {
  id: string
  type: string
  created: number
  data: { object: Record<string, unknown> }
  livemode?: boolean
}

export type ProjectionKind =
  /// Money in. Writes a Payment and a negative LedgerEntry.
  | 'payment_succeeded'
  /// An attempt failed. Writes a Payment row in FAILED, and no ledger
  /// movement - nothing has changed about what is owed.
  | 'payment_failed'
  /// Money back out. Writes a positive LedgerEntry reversing the payment.
  | 'refund'
  /// Recorded for visibility. No ledger movement here.
  | 'dispute'

export interface ProjectionIntent {
  kind: ProjectionKind
  /// Stripe's own id for the thing that moved - invoice or charge. Carried
  /// onto the projected row so a reconciliation can walk back to Stripe.
  stripeObjectId: string
  /// Which Stripe Customer this concerns. The app layer resolves it to a
  /// LeasePayer; an event for a customer we do not know is recorded and
  /// ignored rather than guessed at.
  stripeCustomerId: string | null
  stripeInvoiceId: string | null
  stripePaymentIntentId: string | null
  /// ALWAYS POSITIVE. The sign is a ledger concern and is applied by the
  /// projector, so an event that reports a negative amount for its own
  /// reasons cannot flip a credit into a charge.
  amountCents: number
  /// Stripe's own timestamp for the money event, not when we projected it.
  occurredAt: Date
  description: string
}

export type InterpretResult =
  | { outcome: 'project'; intent: ProjectionIntent }
  /// Recognised, but nothing to project - or unrecognised entirely. Either
  /// way the event is acknowledged so Stripe stops retrying it.
  | { outcome: 'ignore'; reason: string }

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function int(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * What this event means for the projection.
 *
 * Refuses rather than guesses. An event missing the customer, the amount or
 * the object id is `ignore`d with a stated reason instead of being projected
 * with a zero or a null in place of the missing piece - a ledger row with an
 * invented amount is worse than no row, because it looks authoritative.
 */
export function interpretStripeEvent(event: StripeEventEnvelope): InterpretResult {
  if (!isHandledEvent(event.type)) {
    return { outcome: 'ignore', reason: `unhandled event type ${event.type}` }
  }

  const object = event.data?.object
  if (!object || typeof object !== 'object') {
    return { outcome: 'ignore', reason: 'event carried no object' }
  }

  const stripeObjectId = str(object, 'id')
  if (!stripeObjectId) {
    return { outcome: 'ignore', reason: 'object had no id' }
  }

  const stripeCustomerId = str(object, 'customer')
  if (!stripeCustomerId) {
    return { outcome: 'ignore', reason: 'object named no customer' }
  }

  const occurredAt = new Date(event.created * 1000)

  switch (event.type) {
    case 'invoice.payment_succeeded': {
      // `amount_paid`, not `total`: a partially-paid invoice reports what
      // actually arrived, and projecting the total would credit money
      // nobody sent.
      const amount = int(object, 'amount_paid')
      if (amount == null || amount <= 0) {
        return { outcome: 'ignore', reason: 'invoice reported no amount paid' }
      }
      return {
        outcome: 'project',
        intent: {
          kind: 'payment_succeeded',
          stripeObjectId,
          stripeCustomerId,
          stripeInvoiceId: stripeObjectId,
          stripePaymentIntentId: str(object, 'payment_intent'),
          amountCents: amount,
          occurredAt,
          description: str(object, 'description') ?? 'Rent payment',
        },
      }
    }

    case 'invoice.payment_failed': {
      // `amount_due` - what was being attempted. Nothing was paid, so
      // `amount_paid` would be zero and tell a reader nothing.
      const amount = int(object, 'amount_due')
      if (amount == null || amount <= 0) {
        return { outcome: 'ignore', reason: 'invoice reported no amount due' }
      }
      return {
        outcome: 'project',
        intent: {
          kind: 'payment_failed',
          stripeObjectId,
          stripeCustomerId,
          stripeInvoiceId: stripeObjectId,
          stripePaymentIntentId: str(object, 'payment_intent'),
          amountCents: amount,
          occurredAt,
          description: 'Payment attempt failed',
        },
      }
    }

    case 'charge.refunded': {
      const amount = int(object, 'amount_refunded')
      if (amount == null || amount <= 0) {
        return { outcome: 'ignore', reason: 'charge reported no refunded amount' }
      }
      return {
        outcome: 'project',
        intent: {
          kind: 'refund',
          stripeObjectId,
          stripeCustomerId,
          stripeInvoiceId: str(object, 'invoice'),
          stripePaymentIntentId: str(object, 'payment_intent'),
          amountCents: amount,
          occurredAt,
          description: 'Refund',
        },
      }
    }

    case 'charge.dispute.created': {
      const amount = int(object, 'amount')
      if (amount == null || amount <= 0) {
        return { outcome: 'ignore', reason: 'dispute reported no amount' }
      }
      return {
        outcome: 'project',
        intent: {
          kind: 'dispute',
          stripeObjectId,
          stripeCustomerId,
          stripeInvoiceId: null,
          stripePaymentIntentId: str(object, 'payment_intent'),
          amountCents: amount,
          occurredAt,
          description: 'Payment disputed',
        },
      }
    }
  }
}

/**
 * The signed amount a projection intent contributes to the balance owed.
 *
 * The one place the sign is decided. `LedgerEntry.amountCents` is signed -
 * positive increases what is owed, negative reduces it - and getting this
 * backwards would invert every balance in the product, which is the kind of
 * bug that looks fine until somebody is chased for rent they already paid.
 */
export function ledgerAmountCents(intent: ProjectionIntent): number {
  switch (intent.kind) {
    case 'payment_succeeded':
      return -intent.amountCents
    case 'refund':
      // Money going back out re-opens the balance it had closed.
      return intent.amountCents
    case 'payment_failed':
    case 'dispute':
      // Neither moves the balance. A failed attempt leaves the charge
      // exactly as owed as it already was; a dispute is recorded for
      // visibility and its money movement arrives as its own event.
      return 0
  }
}

/// Whether this intent writes a LedgerEntry at all. Kept beside
/// `ledgerAmountCents` so "zero movement" and "no row" cannot drift apart -
/// a zero-amount ledger row would be noise in an append-only table nobody
/// can clean up afterwards.
export function movesLedger(intent: ProjectionIntent): boolean {
  return ledgerAmountCents(intent) !== 0
}
