import 'server-only'

import { randomUUID } from 'node:crypto'
import type { CollectionMethod, PaymentRail } from '@rental/core/payments'
import type {
  BillingProvider,
  CustomerInput,
  PauseBehaviour,
  ProvisionedCustomer,
  ProvisionedSetupIntent,
  ProvisionedSubscription,
  SubscriptionInput,
  SubscriptionRef,
} from './adapter.ts'

// The real Stripe driver (D-11, R-036).
//
// WHY THIS EXISTS NOW, WHEN D-23 SAID IT SHOULD NOT. D-23 deferred it on
// D-15's reasoning: "an HTTP client that has never once been executed,
// against an account that does not exist, produces code that looks finished
// and is untested." That premise held while there was no Stripe account. It
// no longer does - there is one, and the owner's call (recorded as D-26) is
// that this product may use it in TEST MODE. A driver that CAN be executed
// is a driver worth writing, and the objection is answered rather than
// overridden.
//
// ==========================================================================
// TWO CONTROLS MAKE THIS SAFE, AND NEITHER IS OPTIONAL.
//
// 1. IT REFUSES A LIVE KEY, OUTRIGHT, AT CONSTRUCTION. The owner authorised
//    test mode specifically. A `sk_live_` key reaching this class would move
//    real money on a real account belonging to a real business, and the
//    difference between the two keys is four characters in an environment
//    variable that gets copied between machines by hand. Refusing is the
//    only control that survives that; a warning is not.
//
// 2. EVERY WRITE CARRIES AN IDEMPOTENCY KEY. Stripe deduplicates on it for
//    24 hours. Without one, a request that times out after Stripe processed
//    it - the single most likely network failure - gets retried and creates
//    a SECOND subscription, which bills the tenant twice every month
//    thereafter. The key is derived from the FACT being asserted, never
//    randomly, or a retry generates a fresh key and the guarantee is worth
//    nothing. That is the same rule R-016's notification idempotency and
//    R-034's webhook claim already follow.
// ==========================================================================
//
// Hand-rolled over `fetch` rather than the `stripe` SDK. The SDK is a large
// dependency whose value is mostly types and retry logic; this needs eight
// endpoints, form encoding, and one header. If the surface grows past what
// fits in this file, take the SDK - that is a real threshold, not a
// prejudice against it.

const STRIPE_API = 'https://api.stripe.com/v1'
const STRIPE_VERSION = '2024-06-20'

/**
 * How long an invoiced payer has before the invoice is past due.
 *
 * Stripe REQUIRES this on any `send_invoice` subscription and rejects the
 * request without it. Zero would mark rent past due the instant it is issued,
 * which is wrong for a reason that is ours and not Stripe's: whether rent is
 * late is a jurisdiction question with a grace period behind it (D-4), and
 * `lateFeeFor()` in packages/core is what answers it. This number exists only
 * to satisfy Stripe's own validation, so it is set generously and deliberately
 * plays no part in any late-fee decision.
 */
const DAYS_UNTIL_DUE = 30

export class LiveModeRefusedError extends Error {
  constructor() {
    super(
      'STRIPE_SECRET_KEY is a LIVE key. This deployment is authorised for test mode only ' +
        '(D-26) - a live key here would move real money on a real account. Use the sk_test_ ' +
        'key from the Stripe dashboard, or change D-26 deliberately.',
    )
    this.name = 'LiveModeRefusedError'
  }
}

export class StripeRequestError extends Error {
  readonly status: number
  readonly stripeCode: string | null

  constructor(status: number, message: string, stripeCode: string | null) {
    super(`Stripe returned ${status}: ${message}`)
    this.name = 'StripeRequestError'
    this.status = status
    this.stripeCode = stripeCode
  }
}

/// Stripe's form encoding for nested values: `items[0][price]=price_123`.
/// Flat pairs only, which is everything this driver sends.
function formEncode(params: Record<string, string | number | undefined | null>): string {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    body.set(key, String(value))
  }
  return body.toString()
}

export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe-test'
  readonly #secretKey: string

  constructor(secretKey: string) {
    if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) {
      throw new LiveModeRefusedError()
    }
    if (!secretKey.startsWith('sk_test_') && !secretKey.startsWith('rk_test_')) {
      throw new Error(
        'STRIPE_SECRET_KEY does not look like a Stripe secret key (expected sk_test_ or rk_test_).',
      )
    }
    this.#secretKey = secretKey
  }

  async #post(
    path: string,
    params: Record<string, string | number | undefined | null>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${STRIPE_API}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_VERSION,
        // Only on writes that CREATE something. An update is already
        // idempotent by nature - setting a price to X twice leaves it at X -
        // and a stale key on an update would make a legitimate second change
        // silently return the first one's result.
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: formEncode(params),
    })

    const payload = (await response.json()) as Record<string, unknown>
    if (!response.ok) {
      const error = payload.error as { message?: string; code?: string } | undefined
      throw new StripeRequestError(
        response.status,
        error?.message ?? 'unknown error',
        error?.code ?? null,
      )
    }
    return payload
  }

  async #delete(path: string): Promise<void> {
    const response = await fetch(`${STRIPE_API}${path}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.#secretKey}`,
        'Stripe-Version': STRIPE_VERSION,
      },
    })
    // Already gone is the outcome the caller wanted. Stripe answers 404 for a
    // subscription item deleted by a retry of this same call, and treating
    // that as a failure would leave our row marked live for ever.
    if (response.ok || response.status === 404) return
    const payload = (await response.json()) as Record<string, unknown>
    const error = payload.error as { message?: string; code?: string } | undefined
    throw new StripeRequestError(
      response.status,
      error?.message ?? 'unknown error',
      error?.code ?? null,
    )
  }

  async #get(path: string): Promise<Record<string, unknown> | null> {
    const response = await fetch(`${STRIPE_API}${path}`, {
      headers: {
        Authorization: `Bearer ${this.#secretKey}`,
        'Stripe-Version': STRIPE_VERSION,
      },
    })
    if (response.status === 404) return null
    const payload = (await response.json()) as Record<string, unknown>
    if (!response.ok) {
      const error = payload.error as { message?: string; code?: string } | undefined
      throw new StripeRequestError(
        response.status,
        error?.message ?? 'unknown error',
        error?.code ?? null,
      )
    }
    return payload
  }

  async createCustomer(input: CustomerInput): Promise<ProvisionedCustomer> {
    const customer = await this.#post(
      '/customers',
      {
        name: input.name,
        email: input.email,
        phone: input.phone,
        // Metadata so a human in the Stripe dashboard can get back to the
        // lease. Stripe is the source of truth for money (D-11); it should
        // not also be a place where you cannot tell whose money it is.
        'metadata[leasePayerId]': input.leasePayerId,
        'metadata[leaseId]': input.leaseId,
        'metadata[propertyId]': input.propertyId,
      },
      // Derived from the payer, not random: one payer has one customer, and
      // a retry must return the first one rather than making a second.
      `customer:${input.leasePayerId}`,
    )
    return { stripeCustomerId: customer.id as string }
  }

  async createSubscription(input: SubscriptionInput): Promise<ProvisionedSubscription> {
    const price = await this.#createPrice(input.amountCents, input.currency, input.leaseId)

    const subscription = await this.#post(
      '/subscriptions',
      {
        customer: input.stripeCustomerId,
        'items[0][price]': price,
        // Seconds, not milliseconds - and computed in PROPERTY-LOCAL time by
        // `billingCycleAnchor` before it ever reaches here (D-3, D-11).
        billing_cycle_anchor: Math.floor(input.billingCycleAnchor.getTime() / 1000),
        // Stripe would otherwise bill a partial period immediately. Ours to
        // compute and push (D-12, R-042), never Stripe's to invent.
        proration_behavior: 'none',
        // D-29. Set at creation, not patched afterwards: a subscription that
        // bills once on the wrong mode has already asked somebody for money
        // the wrong way. `send_invoice` requires days_until_due, which Stripe
        // rejects the request without.
        collection_method: input.collectionMethod,
        ...(input.collectionMethod === 'send_invoice' ? { days_until_due: DAYS_UNTIL_DUE } : {}),
        'metadata[leaseId]': input.leaseId,
        'metadata[leasePayerId]': input.leasePayerId,
      },
      `subscription:${input.leasePayerId}`,
    )

    return {
      stripeSubscriptionId: subscription.id as string,
      stripePriceId: price,
    }
  }

  /// A Price per rent amount. Stripe Prices are immutable, so a rent change
  /// is a new Price rather than an edit - which is also why the subscription
  /// update below takes one.
  ///
  /// `name` and `key` are for R-042's recurring charges, which need their own
  /// product name (the tenant reads it on every invoice line) and their own
  /// idempotency fact (two leases can carry pet rent at the same amount, and
  /// keying on lease-and-amount alone would hand the second one the first
  /// one's price).
  async #createPrice(
    amountCents: number,
    currency: string,
    leaseId: string,
    name?: string,
    key?: string,
  ): Promise<string> {
    const price = await this.#post(
      '/prices',
      {
        unit_amount: amountCents,
        currency,
        'recurring[interval]': 'month',
        'product_data[name]': name ?? `Rent — lease ${leaseId}`,
        'metadata[leaseId]': leaseId,
      },
      // Keyed on the FACT: this lease at this amount. Re-running a failed
      // provisioning reuses the price rather than littering the account.
      key ?? `price:${leaseId}:${amountCents}:${currency}`,
    )
    return price.id as string
  }

  async createSetupIntent(stripeCustomerId: string): Promise<ProvisionedSetupIntent> {
    const intent = await this.#post('/setup_intents', {
      customer: stripeCustomerId,
      // ACH first: PAY-01 makes it the free rail, and card carries a
      // disclosed pass-through fee.
      'payment_method_types[0]': 'us_bank_account',
      'payment_method_types[1]': 'card',
      usage: 'off_session',
    })
    return {
      setupIntentId: intent.id as string,
      clientSecret: intent.client_secret as string,
    }
  }

  async updateSubscriptionPrice(input: {
    stripeSubscriptionId: string
    amountCents: number
    currency: string
    leaseId: string
  }): Promise<{ stripePriceId: string }> {
    const subscription = await this.#get(`/subscriptions/${input.stripeSubscriptionId}`)
    if (!subscription) {
      throw new StripeRequestError(404, 'subscription not found', 'resource_missing')
    }
    const items = (subscription.items as { data?: { id: string }[] } | undefined)?.data ?? []
    const itemId = items[0]?.id
    if (!itemId) {
      throw new StripeRequestError(422, 'subscription has no items', null)
    }

    const price = await this.#createPrice(input.amountCents, input.currency, input.leaseId)
    await this.#post(`/subscriptions/${input.stripeSubscriptionId}`, {
      'items[0][id]': itemId,
      'items[0][price]': price,
      // THE D-12 LINE. Stripe's proration is built for mid-cycle plan
      // changes, not a calendar rent changing at a renewal boundary. Ours to
      // compute (R-042) and push as an invoice item; never Stripe's.
      proration_behavior: 'none',
    })
    return { stripePriceId: price }
  }

  async pauseSubscription(input: {
    stripeSubscriptionId: string
    behaviour: PauseBehaviour
  }): Promise<void> {
    await this.#post(`/subscriptions/${input.stripeSubscriptionId}`, {
      'pause_collection[behavior]': input.behaviour,
    })
  }

  async resumeSubscription(input: SubscriptionRef): Promise<void> {
    // Stripe clears a pause when the field is set to empty.
    await this.#post(`/subscriptions/${input.stripeSubscriptionId}`, {
      pause_collection: '',
    })
  }

  async cancelSubscription(input: SubscriptionRef & { at?: Date }): Promise<void> {
    if (input.at) {
      await this.#post(`/subscriptions/${input.stripeSubscriptionId}`, {
        cancel_at: Math.floor(input.at.getTime() / 1000),
      })
      return
    }
    const response = await fetch(`${STRIPE_API}/subscriptions/${input.stripeSubscriptionId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.#secretKey}`,
        'Stripe-Version': STRIPE_VERSION,
      },
    })
    if (!response.ok && response.status !== 404) {
      const payload = (await response.json()) as { error?: { message?: string; code?: string } }
      throw new StripeRequestError(
        response.status,
        payload.error?.message ?? 'unknown error',
        payload.error?.code ?? null,
      )
    }
  }

  async getSubscription(input: SubscriptionRef) {
    const subscription = await this.#get(`/subscriptions/${input.stripeSubscriptionId}`)
    if (!subscription) return null

    const items = (subscription.items as { data?: { price?: { unit_amount?: number } }[] })
      ?.data
    const cancelAt = subscription.cancel_at as number | null | undefined

    return {
      status: subscription.status as string,
      amountCents: items?.[0]?.price?.unit_amount ?? null,
      cancelAt: cancelAt ? new Date(cancelAt * 1000) : null,
    }
  }

  // ---- Tenant payments (R-037, D-29) ----

  async setCollectionMethod(
    input: SubscriptionRef & { collectionMethod: CollectionMethod },
  ): Promise<void> {
    // No idempotency key, for the reason #post documents: this is an update,
    // idempotent by nature, and a stale key would make a legitimate switch
    // back silently return the first switch's result.
    await this.#post(`/subscriptions/${input.stripeSubscriptionId}`, {
      collection_method: input.collectionMethod,
      ...(input.collectionMethod === 'send_invoice' ? { days_until_due: DAYS_UNTIL_DUE } : {}),
    })
  }

  async setBillingAnchor(input: {
    stripeSubscriptionId: string
    anchor: Date
  }): Promise<void> {
    // `trial_end`, not `billing_cycle_anchor`: Stripe accepts only `now` or
    // `unchanged` for the latter on an update, so shifting an existing cycle
    // is done by ending a (zero-length) trial at the new anchor. See the
    // interface comment - this grants no trial, because proration is off.
    //
    // Seconds, not milliseconds, and computed property-local before it got
    // here (D-3).
    await this.#post(`/subscriptions/${input.stripeSubscriptionId}`, {
      trial_end: String(Math.floor(input.anchor.getTime() / 1000)),
      // Ours to compute, never Stripe's to invent (D-12, R-042).
      proration_behavior: 'none',
    })
  }

  async setDefaultPaymentMethod(input: {
    stripeCustomerId: string
    stripePaymentMethodId: string
    stripeSubscriptionId?: string | null
  }): Promise<void> {
    // BOTH, and in this order. Stripe falls back to the customer default when
    // a subscription names none, but a subscription created before the method
    // existed keeps whatever it was born with - so relying on the fallback
    // leaves the tenant who just enrolled watching the next invoice go unpaid
    // having done everything asked of them.
    //
    // No idempotency key, for the reason #post documents: these are updates,
    // idempotent by nature, and a stale key would make a legitimate change of
    // card silently return the first one's result.
    await this.#post(`/customers/${input.stripeCustomerId}`, {
      'invoice_settings[default_payment_method]': input.stripePaymentMethodId,
    })
    if (input.stripeSubscriptionId) {
      await this.#post(`/subscriptions/${input.stripeSubscriptionId}`, {
        default_payment_method: input.stripePaymentMethodId,
      })
    }
  }

  async getOpenInvoiceAmountCents(input: SubscriptionRef): Promise<number | null> {
    // `status=open` is issued-and-unpaid. Deliberately NOT `draft`: a draft
    // invoice has not been presented to anybody and blocking a switch on one
    // would refuse for a bill that does not yet exist.
    const list = await this.#get(
      `/invoices?subscription=${encodeURIComponent(input.stripeSubscriptionId)}&status=open&limit=100`,
    )
    if (!list) return null

    const data = list.data as { amount_remaining?: number }[] | undefined
    // An empty list is a real answer - nothing open - and must be
    // distinguishable from "we could not ask", which is null. `switchDecision`
    // treats the two completely differently and a tenant billed twice is what
    // conflating them costs.
    if (!Array.isArray(data)) return null
    return data.reduce((total, invoice) => total + (invoice.amount_remaining ?? 0), 0)
  }

  async markInvoicePaidOutOfBand(input: {
    stripeInvoiceId: string
    reference: string
  }): Promise<void> {
    // `paid_out_of_band` tells Stripe the money arrived elsewhere. It marks
    // the invoice paid and records the amount under the invoice's own
    // `amount_paid_out_of_band`, distinct from `amount_paid` - so Stripe's
    // books stay honest about what actually moved through Stripe.
    //
    // No idempotency key: this is an invoice state transition, and Stripe
    // refuses to pay an already-paid invoice on its own. A stale key would
    // silently return the first call's result for what might be a second,
    // different instrument.
    await this.#post(`/invoices/${input.stripeInvoiceId}/pay`, {
      paid_out_of_band: 'true',
      'metadata[offline_reference]': input.reference,
    })
  }

  async addInvoiceItem(input: {
    stripeCustomerId: string
    amountCents: number
    currency: string
    description: string
    chargeId?: string
    idempotencyKey: string
  }): Promise<{ stripeInvoiceItemId: string }> {
    const item = await this.#post(
      '/invoiceitems',
      {
        customer: input.stripeCustomerId,
        // A finished number, computed and clamped in core (D-12).
        amount: input.amountCents,
        currency: input.currency,
        description: input.description,
        // Rides through to the invoice LINE, which is how the finalization
        // event gets back to the row that caused it.
        ...(input.chargeId ? { 'metadata[chargeId]': input.chargeId } : {}),
      },
      // Keyed on the FACT by the caller - this lease, this charge, this day -
      // so a retried assessment adds the fee once rather than twice.
      input.idempotencyKey,
    )
    return { stripeInvoiceItemId: item.id as string }
  }

  async addSubscriptionItem(input: {
    stripeSubscriptionId: string
    amountCents: number
    currency: string
    description: string
    recurringChargeId: string
    leaseId: string
    idempotencyKey: string
  }): Promise<{ stripePriceId: string; stripeSubscriptionItemId: string }> {
    const price = await this.#createPrice(
      input.amountCents,
      input.currency,
      input.leaseId,
      // The product name is what shows on the invoice line, so it carries the
      // sentence core wrote - "Pet rent — Two cats — $35.00/month".
      input.description,
      `price:recurring:${input.recurringChargeId}:${input.amountCents}:${input.currency}`,
    )

    const item = await this.#post(
      '/subscription_items',
      {
        subscription: input.stripeSubscriptionId,
        price,
        quantity: 1,
        // THE D-12 LINE AGAIN. Adding a pet mid-month does not bill a part
        // month automatically; if one is owed it is ours to compute and push.
        proration_behavior: 'none',
        'metadata[recurringChargeId]': input.recurringChargeId,
        'metadata[leaseId]': input.leaseId,
      },
      input.idempotencyKey,
    )

    return {
      stripePriceId: price,
      stripeSubscriptionItemId: item.id as string,
    }
  }

  async endSubscriptionItem(input: { stripeSubscriptionItemId: string }): Promise<void> {
    // Stripe refuses to delete the LAST item on a subscription, which is the
    // rent - and that refusal is correct rather than an obstacle: a
    // subscription with no items is a lease billing nothing, and ending a
    // tenancy is `cancelSubscription`, not this.
    await this.#delete(
      `/subscription_items/${encodeURIComponent(input.stripeSubscriptionItemId)}?proration_behavior=none`,
    )
  }

  /**
   * Fetches an invoice's PDF from Stripe (R-052, D-50).
   *
   * TWO HOPS, and the second one is deliberately unauthenticated. The API
   * returns `invoice_pdf` as a pre-signed URL on Stripe's file host; sending
   * the secret key there would leak it to a different origin than the one it
   * belongs to. So the key authenticates the lookup, and the download uses
   * the signed URL alone.
   *
   * Every failure returns null rather than throwing. Producing a statement is
   * the important operation and one unavailable invoice must not cost the
   * owner the whole document - the caller names what is missing on the page.
   */
  async getInvoicePdf(stripeInvoiceId: string): Promise<Uint8Array | null> {
    const invoice = await this.#get(`/invoices/${encodeURIComponent(stripeInvoiceId)}`)
    const url = invoice?.invoice_pdf
    if (typeof url !== 'string' || url.length === 0) return null

    const response = await fetch(url)
    if (!response.ok) return null
    return new Uint8Array(await response.arrayBuffer())
  }

  async getOpenInvoice(
    input: SubscriptionRef,
  ): Promise<{ stripeInvoiceId: string; amountRemainingCents: number } | null> {
    const list = await this.#get(
      `/invoices?subscription=${encodeURIComponent(input.stripeSubscriptionId)}&status=open&limit=1`,
    )
    const data = list?.data as { id?: string; amount_remaining?: number }[] | undefined
    const invoice = Array.isArray(data) ? data[0] : undefined
    if (!invoice?.id) return null
    return {
      stripeInvoiceId: invoice.id,
      amountRemainingCents: invoice.amount_remaining ?? 0,
    }
  }

  async createPaymentIntent(input: {
    stripeCustomerId: string
    amountCents: number
    currency: string
    rail: PaymentRail
    leasePayerId: string
    leaseId: string
    idempotencyKey: string
  }): Promise<{ stripePaymentIntentId: string; clientSecret: string }> {
    const intent = await this.#post(
      '/payment_intents',
      {
        customer: input.stripeCustomerId,
        // The TOTAL, card fee included, computed by core (D-12). Stripe is
        // never asked to work out what a tenant owes.
        amount: input.amountCents,
        currency: input.currency,
        'payment_method_types[0]': STRIPE_PAYMENT_METHOD[input.rail],
        'metadata[leaseId]': input.leaseId,
        'metadata[leasePayerId]': input.leasePayerId,
      },
      input.idempotencyKey,
    )
    return {
      stripePaymentIntentId: intent.id as string,
      clientSecret: intent.client_secret as string,
    }
  }

  async createApplicationFeeCustomer(input: {
    applicantId: string
    applicationId: string
    propertyId: string
    name: string
    email: string | null
    phone: string | null
  }): Promise<ProvisionedCustomer> {
    const customer = await this.#post(
      '/customers',
      {
        name: input.name,
        email: input.email,
        phone: input.phone,
        'metadata[applicantId]': input.applicantId,
        'metadata[applicationId]': input.applicationId,
        'metadata[propertyId]': input.propertyId,
      },
      // Derived from the applicant, not random - one applicant has one
      // customer, matching createCustomer's own idempotency shape.
      `application-customer:${input.applicantId}`,
    )
    return { stripeCustomerId: customer.id as string }
  }

  async createApplicationFeePaymentIntent(input: {
    stripeCustomerId: string
    amountCents: number
    currency: string
    applicantId: string
    idempotencyKey: string
  }): Promise<{ stripePaymentIntentId: string; clientSecret: string }> {
    const intent = await this.#post(
      '/payment_intents',
      {
        customer: input.stripeCustomerId,
        amount: input.amountCents,
        currency: input.currency,
        // Card only - no ACH-vs-card policy question for a one-off fee.
        'payment_method_types[0]': 'card',
        'metadata[applicantId]': input.applicantId,
      },
      input.idempotencyKey,
    )
    return {
      stripePaymentIntentId: intent.id as string,
      clientSecret: intent.client_secret as string,
    }
  }

  async paymentMethodExpiry(
    stripePaymentMethodId: string,
  ): Promise<{ expMonth: number; expYear: number } | null> {
    const method = await this.#get(`/payment_methods/${encodeURIComponent(stripePaymentMethodId)}`)
    const card = method?.card as { exp_month?: number; exp_year?: number } | undefined
    // Absent for a bank-debit method, and for a payment method Stripe no
    // longer has - both are "nothing to warn about", not an error.
    if (!card?.exp_month || !card?.exp_year) return null
    return { expMonth: card.exp_month, expYear: card.exp_year }
  }
}

/// Our rail names to Stripe's payment method types. RETAIL_CASH has no Stripe
/// equivalent - it is a third-party network (PAY-01) with no driver yet - and
/// is refused here rather than silently falling back to a card, which would
/// charge a fee to a tenant who chose cash specifically to avoid one.
const STRIPE_PAYMENT_METHOD: Record<PaymentRail, string> = {
  ACH: 'us_bank_account',
  CARD: 'card',
  RETAIL_CASH: 'unsupported',
}

/// A stable idempotency key for a caller that has its own notion of the fact
/// being asserted. Exported so the lifecycle layer can key a retryable
/// operation on the lease and the change, rather than on the attempt.
export function idempotencyKeyFor(fact: string): string {
  return fact
}

/// Only used where a genuinely new, unrepeatable operation is being started.
/// Kept explicit so that reaching for it is a visible decision.
export function oneOffIdempotencyKey(): string {
  return randomUUID()
}
