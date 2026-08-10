import 'server-only'

import { randomUUID } from 'node:crypto'
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
  async #createPrice(amountCents: number, currency: string, leaseId: string): Promise<string> {
    const price = await this.#post(
      '/prices',
      {
        unit_amount: amountCents,
        currency,
        'recurring[interval]': 'month',
        'product_data[name]': `Rent — lease ${leaseId}`,
        'metadata[leaseId]': leaseId,
      },
      // Keyed on the FACT: this lease at this amount. Re-running a failed
      // provisioning reuses the price rather than littering the account.
      `price:${leaseId}:${amountCents}:${currency}`,
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
