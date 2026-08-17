import 'server-only'

import type { CollectionMethod, PaymentRail } from '@rental/core/payments'

// The billing provider seam (D-11, D-15's pattern, R-034).
//
// WHY A SEAM RATHER THAN A STRIPE CLIENT. D-11 makes Stripe the source of
// truth for money, and this deployment has no Stripe credentials: the
// multi-LLC KYB underwriting the backlog flags at R-001 has a real lead
// time and has not cleared. D-15 already decided what to do in exactly this
// situation, for Resend and Twilio: "writing an HTTP client that has never
// once been executed - against an account that does not exist - produces
// code that looks finished and is untested, which is strictly worse than an
// honest seam."
//
// So the OUTBOUND half is a seam with a simulator behind it. The INBOUND
// half - signature verification, idempotency, the projection pipeline - is
// built for real and tested exhaustively, because R-021 drew that line and
// it is the right one: a receiver can be exercised completely with synthetic
// requests, and it is the security boundary of a public endpoint.
//
// What the simulator is NOT: a stub that returns fixed strings. It mints
// Stripe-shaped ids AND can emit the webhook events Stripe would emit for
// them, which is what lets the whole inbound pipeline be exercised end to
// end against realistic payloads. A simulator that only minted ids would
// leave the valuable machinery untested.

export interface CustomerInput {
  /// Our own id for the payer, sent to Stripe as metadata so a human looking
  /// at the Stripe dashboard can get back to the lease.
  leasePayerId: string
  leaseId: string
  propertyId: string
  name: string
  email: string | null
  phone: string | null
}

export interface SubscriptionInput {
  stripeCustomerId: string
  /// Integer cents. D-12: core decides the amount, Stripe executes it.
  amountCents: number
  currency: string
  /// The instant computed by `billingCycleAnchor` in property-local time.
  billingCycleAnchor: Date
  leaseId: string
  leasePayerId: string
  /// How Stripe should collect (D-29). Set at creation rather than patched
  /// afterwards, because a subscription that bills once on the wrong mode
  /// has already asked somebody for money the wrong way.
  collectionMethod: CollectionMethod
}

export interface ProvisionedCustomer {
  stripeCustomerId: string
}

export interface ProvisionedSubscription {
  stripeSubscriptionId: string
  stripePriceId: string
}

export interface ProvisionedSetupIntent {
  clientSecret: string
  setupIntentId: string
}

/// Why a subscription is being paused. Stripe's own `pause_collection`
/// behaviours, named here so a caller picks one deliberately rather than
/// passing a magic string.
export const PAUSE_BEHAVIOURS = [
  /// Invoices still generate but are marked uncollectible. The right choice
  /// for a tenancy in a legal-action hold (PAY-12): the debt is still real
  /// and still on the record, we are simply not collecting on it.
  'mark_uncollectible',
  /// Invoices generate as drafts. For a pause somebody intends to unwind.
  'keep_as_draft',
  /// No invoice at all. For a period where nothing is genuinely owed.
  'void',
] as const
export type PauseBehaviour = (typeof PAUSE_BEHAVIOURS)[number]

export interface SubscriptionRef {
  stripeSubscriptionId: string
}

/**
 * Everything this product asks Stripe to DO.
 *
 * Deliberately narrow. R-036 owns the subscription lifecycle (pause, resume,
 * cancel, re-sync), R-037 owns tenant-facing payment, R-040 owns pushing
 * core-computed invoice items. Each will widen this interface when it needs
 * to - a wider one now would be method signatures guessed at ahead of their
 * only caller.
 */
export interface BillingProvider {
  readonly name: string
  createCustomer(input: CustomerInput): Promise<ProvisionedCustomer>
  createSubscription(input: SubscriptionInput): Promise<ProvisionedSubscription>
  /// PAY-02's saved payment method. Stripe-hosted fields only - this returns
  /// a client secret for their Elements to use, and no card or bank number
  /// ever reaches this product (master PRD §6.6).
  createSetupIntent(stripeCustomerId: string): Promise<ProvisionedSetupIntent>

  /**
   * Makes a saved payment method the one future invoices are charged to
   * (PAY-02, R-039a).
   *
   * Set on BOTH the customer and the subscription, deliberately. Stripe falls
   * back to the customer default when a subscription names none, but "falls
   * back" is not a guarantee to build autopay on: a subscription created
   * before the method existed would otherwise keep whatever it was born with,
   * and the tenant who just enrolled would watch the next invoice go unpaid
   * having done everything asked of them.
   */
  setDefaultPaymentMethod(input: {
    stripeCustomerId: string
    stripePaymentMethodId: string
    stripeSubscriptionId?: string | null
  }): Promise<void>

  // ---- Lifecycle (R-036) ----

  /**
   * Moves a subscription to a new rent amount.
   *
   * NEVER PRORATES. Stripe's proration is built for mid-cycle plan changes,
   * not for a calendar rent that changes at a renewal boundary - and D-12 is
   * explicit that any amount a statute could touch is computed in core and
   * pushed as an invoice item. So every implementation passes
   * `proration_behavior=none`, and R-042 owns computing and pushing the
   * partial period when one is genuinely owed.
   */
  /**
   * Moves the day a subscription bills (PAY-02, R-039a).
   *
   * VIA `trial_end`, WHICH LOOKS WRONG AND IS NOT. Stripe does not accept an
   * arbitrary `billing_cycle_anchor` on an update - only `now` or
   * `unchanged` - so the documented way to shift an existing cycle is to set
   * `trial_end` to the instant the next period should begin. Nothing about
   * this grants a free trial: `proration_behavior: 'none'` means no credit
   * and no charge for the gap, and the tenant simply gets billed on the new
   * day from then on.
   *
   * D-12 still holds. Stripe is being told WHEN to bill, never asked to work
   * out what the move is worth - any amount owed for the shifted days is
   * ours to compute and push as an invoice item.
   */
  setBillingAnchor(input: {
    stripeSubscriptionId: string
    /// The instant the next full period should begin, computed
    /// property-local (D-3) before it reaches here.
    anchor: Date
  }): Promise<void>

  updateSubscriptionPrice(input: {
    stripeSubscriptionId: string
    amountCents: number
    currency: string
    leaseId: string
  }): Promise<{ stripePriceId: string }>

  /// PAY-12's collection hold, and the pause half of the lifecycle.
  pauseSubscription(input: {
    stripeSubscriptionId: string
    behaviour: PauseBehaviour
  }): Promise<void>

  resumeSubscription(input: SubscriptionRef): Promise<void>

  /**
   * Ends a subscription.
   *
   * `at` is when it should stop billing - a move-out date, normally. Absent
   * means immediately. Given a date, Stripe stops at that instant rather
   * than mid-period, which is what a tenancy ending on the last day of a
   * month actually means.
   */
  cancelSubscription(input: SubscriptionRef & { at?: Date }): Promise<void>

  /// What Stripe currently thinks the subscription is. The read half of the
  /// re-sync action - a screen that offered to fix drift without first
  /// asking Stripe what it believes would be guessing.
  getSubscription(
    input: SubscriptionRef,
  ): Promise<{ status: string; amountCents: number | null; cancelAt: Date | null } | null>

  // ---- Tenant payments (R-037, D-29) ----

  /**
   * Moves a subscription between autopay and invoice collection.
   *
   * Guarded by `switchDecision()` in packages/core BEFORE it is called - this
   * is the execution half, and it deliberately does not re-litigate the
   * decision. D-12's split: core decides, Stripe executes.
   */
  setCollectionMethod(
    input: SubscriptionRef & { collectionMethod: CollectionMethod },
  ): Promise<void>

  /**
   * What Stripe says is still owed on this subscription's issued invoices.
   *
   * The fact `switchDecision()` refuses without. Returns null when we could
   * not establish it, which the decision treats as "do not act" rather than
   * as "nothing owed" - guessing here bills a tenant twice.
   */
  getOpenInvoiceAmountCents(input: SubscriptionRef): Promise<number | null>

  /**
   * A one-time tenant-initiated payment (PAY-01).
   *
   * Returns a client secret for Stripe-hosted fields. NO CARD OR BANK NUMBER
   * EVER REACHES THIS PRODUCT (master PRD §6.6) - this product never sees
   * more than an id and an amount.
   *
   * `amountCents` is the total to charge INCLUDING any card fee, which core
   * computed (D-12). The provider does not add anything to it.
   */
  /**
   * Marks an issued invoice paid OUTSIDE Stripe (PAY-05, R-038).
   *
   * For a check, a money order or notes handed over at the office. Stripe
   * records the amount as paid out of band and stops collecting - which is
   * the point: a payment Stripe does not know about is a payer it goes on
   * debiting, and a tenant who paid by check being charged again is the
   * failure this call exists to prevent.
   *
   * Settles the WHOLE invoice. Applying a part-payment this way would
   * forgive the remainder silently, which is why the caller refuses one.
   */
  markInvoicePaidOutOfBand(input: {
    stripeInvoiceId: string
    /// Ours, for the audit trail on Stripe's side - the check number or
    /// "cash, received by <staff>". Stripe never validates it.
    reference: string
  }): Promise<void>

  /**
   * Adds a one-off amount to the payer's next invoice (D-12, R-040).
   *
   * THE MECHANISM FOR EVERY JURISDICTION-DEPENDENT CHARGE. A late fee, an
   * NSF fee, a proration - core computes the number and clamps it to the
   * statute, and Stripe is handed a finished amount to bill. Stripe is never
   * asked to work out what a tenant owes, because Stripe does not know what
   * state the property is in.
   *
   * Stripe attaches a pending invoice item to the customer's NEXT invoice
   * automatically, which is what makes this the right shape: the fee rides
   * along with the rent rather than arriving as its own demand.
   */
  addInvoiceItem(input: {
    stripeCustomerId: string
    amountCents: number
    currency: string
    /// What the tenant will see on the invoice line. Written by core, so it
    /// can say WHY - "late fee, 5 days past due, capped at the Texas
    /// maximum" defends itself in a way that "Late fee" does not.
    description: string
    /// OUR charge id, carried into Stripe's metadata so the invoice event
    /// that bills it can be linked back to the row that caused it. Without
    /// this round trip a projected CHARGE entry names no charge, and every
    /// reader that asks "what is still outstanding on this fee" gets the
    /// answer "all of it" forever.
    chargeId?: string
    idempotencyKey: string
  }): Promise<{ stripeInvoiceItemId: string }>

  /**
   * Adds a monthly line beside the rent (PAY-08, R-042).
   *
   * PET RENT AND A FLAT UTILITY FEE, and nothing whose amount a statute could
   * touch. D-12's rule is about statutes: a late fee, an NSF fee and a
   * proration are all clamped by jurisdiction config and so are computed in
   * core and pushed as ONE-OFF invoice items. Agreed pet rent is a term of
   * the contract, exactly like the rent itself - which has been a Stripe
   * subscription since R-034 - so Stripe may hold the repetition.
   *
   * A variable monthly amount is NOT this. RUBS differs every month with the
   * underlying bill, so it stays an invoice item computed per bill.
   *
   * Returns the price as well as the item because Stripe Prices are
   * immutable: changing the amount later means a new Price, exactly as a rent
   * change does.
   */
  addSubscriptionItem(input: {
    stripeSubscriptionId: string
    amountCents: number
    currency: string
    /// What the tenant reads on every invoice from here on, written by core.
    description: string
    /// Ours, carried into Stripe's metadata so a line on an invoice can be
    /// traced back to the row that agreed it.
    recurringChargeId: string
    leaseId: string
    idempotencyKey: string
  }): Promise<{ stripePriceId: string; stripeSubscriptionItemId: string }>

  /**
   * Stops a monthly line.
   *
   * NEVER PRORATES, for the same reason nothing else here does (D-12). Rent
   * bills monthly in advance, so the period already invoiced stands and the
   * line simply stops appearing on the next one. A credit for the unused part
   * of a month is a decision somebody makes deliberately, as a waiver, with a
   * reason recorded - not a side effect of a pet moving out.
   */
  endSubscriptionItem(input: { stripeSubscriptionItemId: string }): Promise<void>

  /// The open invoice to apply an offline payment to, with its id - the
  /// amount alone is not enough here, because the caller has to name the
  /// invoice it is marking paid.
  getOpenInvoice(
    input: SubscriptionRef,
  ): Promise<{ stripeInvoiceId: string; amountRemainingCents: number } | null>

  createPaymentIntent(input: {
    stripeCustomerId: string
    amountCents: number
    currency: string
    rail: PaymentRail
    leasePayerId: string
    leaseId: string
    /// Ours, and stable for the attempt: the retry of a timed-out request
    /// must not become a second charge.
    idempotencyKey: string
  }): Promise<{ stripePaymentIntentId: string; clientSecret: string }>

  /**
   * Card expiry for a saved payment method, when Stripe has one on record
   * (R-045).
   *
   * READ FROM THE PROVIDER, ALWAYS - never mirrored into our own schema.
   * D-11 makes Stripe the source of truth for money, and "never store card,
   * bank, or SSN data" is the harder rule underneath it: month/year is the
   * part of a card that is safe to display, but this product's answer to
   * "where does that number live" is the same for every fact Stripe knows -
   * ask Stripe, do not keep a second copy that can go stale or leak.
   *
   * Null for a bank-debit method (ACH `us_bank_account`), which has no
   * expiry, and for a payment method Stripe no longer has on file.
   */
  paymentMethodExpiry(
    stripePaymentMethodId: string,
  ): Promise<{ expMonth: number; expYear: number } | null>

  /**
   * The provider's own PDF for an invoice (R-052, PAY-09, D-50).
   *
   * WHY THE PROVIDER'S FILE AND NOT OURS. D-11 makes Stripe the system of
   * record for money and `LedgerEntry` a projection of it. A statement of
   * account is therefore our READING of the record, and the invoice is the
   * record. A court packet containing only the reading asks the reader to
   * trust the projection; appending the invoices lets them check it.
   *
   * NULL, NEVER A THROW, when the invoice cannot be produced - the simulator
   * has no such file at all, and the live provider can be down or can have
   * had the invoice voided. The caller prints which invoices are missing on
   * the statement itself rather than quietly shipping a shorter document
   * (see `attachmentBlocks` for why silence there would be a false claim).
   */
  getInvoicePdf(stripeInvoiceId: string): Promise<Uint8Array | null>
}
