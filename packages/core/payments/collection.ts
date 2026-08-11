// How a payer is collected from, and when that may change (PAY-01, PAY-02,
// PAY-03; D-29).
//
// D-29 settled OQ-11: Stripe cannot do autopay and partial payments on one
// subscription, so the collection method is PER PAYER and it switches.
// `charge_automatically` pulls from a saved method on the billing day;
// `send_invoice` bills the payer and lets them pay what they can, when they
// can. Both Must stories ship, for the payers on the mode that supports each.
//
// THE WHOLE RISK OF D-29 LIVES IN THE SWITCH. Two collection modes are
// individually simple; moving a payer between them mid-cycle is where a
// tenant gets asked for the same rent twice. This file is the decision that
// prevents it, and it is deliberately conservative: it refuses far more
// often than a naive implementation would, because the failure it is
// avoiding is a double debit against somebody's rent money.

export type CollectionMethod = 'charge_automatically' | 'send_invoice'

export const COLLECTION_METHODS: readonly CollectionMethod[] = [
  'charge_automatically',
  'send_invoice',
] as const

export function isCollectionMethod(value: string): value is CollectionMethod {
  return value === 'charge_automatically' || value === 'send_invoice'
}

/**
 * Whether this payer may pay less than the full amount owed.
 *
 * The single behavioural difference OQ-11 was about. Stripe supports partial
 * payments only on `send_invoice` invoices - see
 * https://docs.stripe.com/invoicing/partial-payments - and enforcing it here
 * rather than at the UI means a hand-crafted request cannot get around it and
 * land us with a partial payment Stripe will not reconcile.
 */
export function allowsPartialPayment(method: CollectionMethod): boolean {
  return method === 'send_invoice'
}

/**
 * Whether Stripe will pull from a saved method without the payer acting.
 *
 * Named for what it DOES rather than for the mode, because two later features
 * ask this question and neither cares about Stripe's vocabulary: PAY-02's
 * T-2-day pre-debit notice is owed exactly when this is true, and PAY-12's
 * legal-action hold (R-047) is urgent for the same reason - an autopay charge
 * that fires the morning after a notice is served can void the notice.
 */
export function debitsAutomatically(method: CollectionMethod): boolean {
  return method === 'charge_automatically'
}

// ---- Switching between modes ----

export type SwitchRefusal =
  /// A payment we have not heard the end of. Its outcome decides whether the
  /// balance is owed, so nothing about billing may move underneath it.
  | 'payment_in_flight'
  /// An issued invoice with money still on it. The new mode's subscription
  /// would bill the same period again.
  | 'open_invoice'
  /// Collection is paused (PAY-12). Changing HOW we collect while we have
  /// decided not to collect is a change with no meaning and a real risk:
  /// R-047 pauses precisely so nothing bills, and a switch that resumed
  /// billing as a side effect would defeat it.
  | 'collection_paused'
  /// There is no subscription to change.
  | 'not_provisioned'
  /**
   * The payer has no email address, and Stripe REFUSES `send_invoice`
   * without one: "Missing email. In order to create invoices that are sent
   * to the customer, the customer must have a valid email."
   *
   * Found by actually calling Stripe rather than by reading its docs, which
   * is the whole argument for the smoke test that found it. Every unit test
   * asserted we sent the right request; only Stripe could say the customer
   * was not ready to receive it.
   */
  | 'no_email_for_invoicing'

export interface SwitchFacts {
  current: CollectionMethod
  target: CollectionMethod
  hasSubscription: boolean
  collectionPaused: boolean
  /// A payment against this payer that Stripe has accepted but not settled -
  /// an ACH debit in its 3-5 day window, typically. Counted from OUR payment
  /// rows, which are themselves a projection of Stripe's events (D-11).
  /// Whether the payer has an email address on file. Only consulted when
  /// moving TO `send_invoice` - autopay pulls from a saved method and needs
  /// no address to send anything to.
  payerHasEmail: boolean
  paymentsInFlight: number
  /// What STRIPE says is still owed on an issued invoice, in cents. Null
  /// means we have not asked - which is treated as "do not act", never as
  /// "nothing owed", the same rule R-036's lifecycle decision follows.
  openInvoiceAmountCents: number | null
}

export interface SwitchDecision {
  allowed: boolean
  refusal?: SwitchRefusal
  /// True when the target is already the current method. Not a refusal - a
  /// caller asking for a state that already holds should be told it holds.
  alreadySet?: boolean
}

/**
 * Whether this payer may move to the other collection method right now.
 *
 * THE ORDER OF THE REFUSALS IS THE DESIGN. A payment in flight outranks an
 * open invoice, because the in-flight payment's outcome is what decides
 * whether the invoice is owed at all - refusing on the invoice first would
 * tell staff to chase a balance that is about to settle itself.
 *
 * `openInvoiceAmountCents: null` refuses. That is deliberate and it is the
 * same rule R-036 applies to a subscription it has not read: acting on the
 * difference between what we believe and what we have not asked about is
 * acting on an assumption, and the cost of this particular assumption being
 * wrong is a tenant billed twice for one month's rent.
 *
 * Note what is NOT here: no check on the billing day, no "wait until the end
 * of the cycle". A cycle boundary is not the hazard - an unsettled invoice
 * is, and one can exist on any day of the month.
 */
export function switchDecision(facts: SwitchFacts): SwitchDecision {
  if (facts.current === facts.target) return { allowed: false, alreadySet: true }
  if (!facts.hasSubscription) return { allowed: false, refusal: 'not_provisioned' }
  if (facts.collectionPaused) return { allowed: false, refusal: 'collection_paused' }
  // Before the money checks: this one is about whether the target mode can
  // work at all, not about whether now is a safe moment to move.
  if (facts.target === 'send_invoice' && !facts.payerHasEmail) {
    return { allowed: false, refusal: 'no_email_for_invoicing' }
  }
  if (facts.paymentsInFlight > 0) return { allowed: false, refusal: 'payment_in_flight' }
  if (facts.openInvoiceAmountCents == null || facts.openInvoiceAmountCents > 0) {
    return { allowed: false, refusal: 'open_invoice' }
  }
  return { allowed: true }
}

/// What to tell staff, as a sentence that says what is wrong AND what to do.
/// Same rule as R-030's close refusals: a form that only says no is a form
/// somebody works around.
export const SWITCH_REFUSALS: Record<SwitchRefusal, string> = {
  payment_in_flight:
    'A payment is still clearing. Wait for it to settle or fail — switching now could bill this month twice.',
  open_invoice:
    'There is still an unpaid invoice for this payer. Settle or void it first, then switch — otherwise the new subscription bills the same period again.',
  collection_paused:
    'Collection is paused for this payer. Resume it first if you mean to start collecting again.',
  not_provisioned:
    'This payer has no subscription yet. It picks up the collection method when billing is set up.',
  no_email_for_invoicing:
    'Invoiced billing needs an email address for this payer — the billing provider will not send an invoice without one. Add an email to their record first, or keep them on automatic payments and take part-payments in person.',
}

// ---- What a payer may actually pay with ----

/// Every rail a tenant can push money down. `RETAIL_CASH` is PAY-01's
/// cash-preferring tenant; the others are Stripe-hosted. Deliberately the
/// same names as the `PaymentChannel` enum R-002 already wrote, so the two
/// cannot drift.
export type PaymentRail = 'ACH' | 'CARD' | 'RETAIL_CASH'

export interface RailAvailability {
  rail: PaymentRail
  available: boolean
  /// Why not, when not - shown to the tenant, so it says what they can do
  /// instead rather than naming an internal condition.
  unavailableReason?: string
}

/**
 * Which rails to offer this payer, in the order they should be offered.
 *
 * ACH FIRST AND ALWAYS, because it is free to the tenant (PAY-01) and cheap
 * to the owner. Card second, carrying its disclosed fee. Ordering is not
 * cosmetic here: a payment screen that leads with the card is a screen that
 * quietly costs tenants money, and the fee is theirs to pay under PAY-01.
 *
 * Retail cash is offered only where it has actually been configured, because
 * an option a tenant selects and then cannot complete is worse than one that
 * was never shown.
 */
export function railsFor(input: {
  method: CollectionMethod
  cardPermitted: boolean
  retailCashConfigured: boolean
}): RailAvailability[] {
  return [
    { rail: 'ACH', available: true },
    {
      rail: 'CARD',
      available: input.cardPermitted,
      ...(input.cardPermitted
        ? {}
        : {
            unavailableReason:
              'Card payments are not available for this property. Bank transfer is free.',
          }),
    },
    {
      rail: 'RETAIL_CASH',
      available: input.retailCashConfigured,
      ...(input.retailCashConfigured
        ? {}
        : { unavailableReason: 'Paying with cash in a store is not set up for this property yet.' }),
    },
  ]
}

// ---- What a payer may pay, right now ----

export type AmountRefusal =
  /// Nothing is owed. A tenant who is square should be told so, not shown a
  /// form that cannot be submitted.
  | 'nothing_owed'
  /// Everything owed is already covered by money in flight. Paying again
  /// would be a second debit for one month's rent.
  | 'already_covered'
  /// Less than the full amount, on a payer whose mode cannot take a partial
  /// payment (D-29).
  | 'partial_not_allowed'
  | 'not_a_positive_amount'
  | 'more_than_owed'

export interface PayableFacts {
  method: CollectionMethod
  /// What the ledger says is owed. May be zero or negative - a credit
  /// balance is a real state.
  balanceCents: number
  /// Payments Stripe has accepted but not settled. An ACH debit sits here
  /// for three to five days.
  inFlightCents: number
}

export interface Payable {
  /// The most this payer should be asked for: what is owed, less what is
  /// already on its way.
  ///
  /// SUBTRACTING IN-FLIGHT MONEY IS THE POINT. An ACH debit does not move
  /// the ledger until it settles (see `ledgerAmountCents`), and rightly so -
  /// but a payment screen that ignored it would show the full balance to a
  /// tenant who paid three days ago and invite them to pay it again. The
  /// ledger stays honest about what has arrived; this stays honest about
  /// what to ask for.
  maxCents: number
  /// Whether they may send less than `maxCents` (D-29).
  allowsPartial: boolean
  inFlightCents: number
}

export function payable(facts: PayableFacts): Payable {
  return {
    maxCents: Math.max(0, facts.balanceCents - facts.inFlightCents),
    allowsPartial: allowsPartialPayment(facts.method),
    inFlightCents: facts.inFlightCents,
  }
}

/**
 * Whether this payer may send this amount right now.
 *
 * Refuses an overpayment. Prepaying next month's rent is a legitimate thing
 * a tenant might want, and it is deliberately NOT supported here: a credit
 * balance has to be allocated somewhere (R-035's `allocatePayment`), and the
 * allocation order is jurisdiction configuration. Accepting money this flow
 * cannot correctly place would be worse than declining it. R-043 owns
 * prepayment if it turns out to be wanted.
 */
export function validatePaymentAmount(
  facts: PayableFacts,
  amountCents: number,
): { ok: true } | { ok: false; refusal: AmountRefusal } {
  const limits = payable(facts)

  if (facts.balanceCents <= 0) return { ok: false, refusal: 'nothing_owed' }
  if (limits.maxCents <= 0) return { ok: false, refusal: 'already_covered' }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, refusal: 'not_a_positive_amount' }
  }
  if (amountCents > limits.maxCents) return { ok: false, refusal: 'more_than_owed' }
  if (amountCents < limits.maxCents && !limits.allowsPartial) {
    return { ok: false, refusal: 'partial_not_allowed' }
  }
  return { ok: true }
}

/// Sentences for a TENANT, not for staff. Each says what they can do rather
/// than naming an internal condition - a tenant reading "collection method
/// does not permit partial payment" learns nothing they can act on.
export const AMOUNT_REFUSALS: Record<AmountRefusal, string> = {
  nothing_owed: 'Your balance is clear — there is nothing to pay right now.',
  already_covered:
    'A payment is already on its way for everything you owe. It can take a few days to clear, and we will email you when it does.',
  partial_not_allowed:
    'This account is set up to pay the full amount. If you need to pay part of it, contact the office and we can change that for you.',
  not_a_positive_amount: 'Enter how much you would like to pay.',
  more_than_owed: 'That is more than you owe. Enter the amount shown or less.',
}
