import { afterEach, describe, expect, it } from 'vitest'
import { LiveModeRefusedError, StripeBillingProvider } from './stripe-adapter.ts'

// The two controls that make a real Stripe driver safe to have in the tree
// (D-26). Neither needs a network call to test, and both are the kind of
// thing that is only ever exercised on the day it matters - so they are
// tested on every other day instead.

describe('live-mode refusal', () => {
  it('REFUSES an sk_live_ key outright', () => {
    // The owner authorised test mode specifically. The difference between
    // the two keys is four characters in an environment variable that gets
    // copied between machines by hand, and a live key here would move real
    // money on a real business's account.
    expect(() => new StripeBillingProvider('sk_live_abc123')).toThrow(LiveModeRefusedError)
  })

  it('refuses a live RESTRICTED key too', () => {
    // rk_live_ is just as live as sk_live_.
    expect(() => new StripeBillingProvider('rk_live_abc123')).toThrow(LiveModeRefusedError)
  })

  it('says WHY, and names the decision', () => {
    // A refusal somebody cannot act on gets worked around.
    try {
      new StripeBillingProvider('sk_live_abc123')
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as Error).message).toMatch(/test mode only/)
      expect((error as Error).message).toMatch(/D-26/)
      expect((error as Error).message).toMatch(/sk_test_/)
    }
  })

  it('accepts a test key', () => {
    expect(() => new StripeBillingProvider('sk_test_abc123')).not.toThrow()
    expect(() => new StripeBillingProvider('rk_test_abc123')).not.toThrow()
  })

  it('refuses something that is not a Stripe key at all', () => {
    // A blank or pasted-wrong value must not silently become a provider
    // that fails later with an authentication error nobody can place.
    for (const bad of ['', 'hunter2', 'pk_test_abc', 'whsec_abc']) {
      expect(() => new StripeBillingProvider(bad), bad).toThrow()
    }
  })

  it('reports its own name as test-mode, so no screen can imply otherwise', () => {
    expect(new StripeBillingProvider('sk_test_abc123').name).toBe('stripe-test')
  })
})

describe('what the driver actually sends', () => {
  // Restored after every test. A replaced global that is never put back
  // leaks into whatever runs next in this worker, and the failure lands
  // somewhere unrelated - which is a worse debugging afternoon than the one
  // it saved.
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  // No network. These intercept fetch and assert on the request, because the
  // shape of these calls is the difference between billing correctly and
  // billing twice - and none of it is exercised until there is a test key.

  function captureFetch() {
    const calls: { url: string; init: RequestInit }[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(
        JSON.stringify({
          id: 'obj_1',
          client_secret: 'seti_1_secret_x',
          items: { data: [{ id: 'si_1', price: { unit_amount: 150_000 } }] },
          status: 'active',
          cancel_at: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    return calls
  }

  const provider = () => new StripeBillingProvider('sk_test_abc123')

  it('sends a STABLE idempotency key derived from the payer, not a random one', async () => {
    // A request that times out after Stripe processed it is the most likely
    // network failure there is. A retry with a fresh key creates a second
    // subscription that bills the tenant twice, every month, thereafter.
    const calls = captureFetch()
    await provider().createCustomer({
      leasePayerId: 'payer_1',
      leaseId: 'lease_1',
      propertyId: 'prop_1',
      name: 'Pat Payer',
      email: null,
      phone: null,
    })

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe('customer:payer_1')
  })

  it('NEVER lets Stripe prorate a price change (D-12)', async () => {
    const calls = captureFetch()
    await provider().updateSubscriptionPrice({
      stripeSubscriptionId: 'sub_1',
      amountCents: 165_000,
      currency: 'usd',
      leaseId: 'lease_1',
    })
    const update = calls.find((c) => c.init.method === 'POST' && c.url.endsWith('/subscriptions/sub_1'))
    expect(String(update!.init.body)).toContain('proration_behavior=none')
  })

  it('sends the billing anchor as UNIX SECONDS, not milliseconds', async () => {
    // Milliseconds would put the anchor about fifty thousand years out and
    // Stripe would reject it - or worse, not.
    const calls = captureFetch()
    const anchor = new Date('2026-04-01T14:00:00Z')
    await provider().createSubscription({
      stripeCustomerId: 'cus_1',
      amountCents: 150_000,
      currency: 'usd',
      billingCycleAnchor: anchor,
      leaseId: 'lease_1',
      leasePayerId: 'payer_1',
      collectionMethod: 'charge_automatically',
    })
    const create = calls.find((c) => c.url.endsWith('/subscriptions'))
    expect(String(create!.init.body)).toContain(
      `billing_cycle_anchor=${Math.floor(anchor.getTime() / 1000)}`,
    )
  })

  it('cancels AT a date when given one, rather than immediately', async () => {
    const calls = captureFetch()
    const at = new Date('2026-08-31T12:00:00Z')
    await provider().cancelSubscription({ stripeSubscriptionId: 'sub_1', at })
    expect(calls[0]!.init.method).toBe('POST')
    expect(String(calls[0]!.init.body)).toContain(`cancel_at=${Math.floor(at.getTime() / 1000)}`)
  })

  it('DELETEs when cancelling immediately', async () => {
    const calls = captureFetch()
    await provider().cancelSubscription({ stripeSubscriptionId: 'sub_1' })
    expect(calls[0]!.init.method).toBe('DELETE')
  })

  it('clears the pause by sending an empty value, which is how Stripe resumes', async () => {
    const calls = captureFetch()
    await provider().resumeSubscription({ stripeSubscriptionId: 'sub_1' })
    expect(String(calls[0]!.init.body)).toContain('pause_collection=')
  })

  it('sends days_until_due with send_invoice, which Stripe REQUIRES', async () => {
    // Stripe rejects a `send_invoice` subscription without it. Exactly the
    // kind of thing that passes every local test and fails the first time it
    // meets the real API, so it is asserted on the request body.
    const calls = captureFetch()
    await provider().createSubscription({
      stripeCustomerId: 'cus_1',
      amountCents: 150_000,
      currency: 'usd',
      billingCycleAnchor: new Date('2026-09-01T14:00:00Z'),
      leaseId: 'lease_1',
      leasePayerId: 'payer_1',
      collectionMethod: 'send_invoice',
    })
    const create = calls.find((c) => c.url.endsWith('/subscriptions'))!
    const body = String(create.init.body)
    expect(body).toContain('collection_method=send_invoice')
    expect(body).toContain('days_until_due=')
  })

  it('does NOT send days_until_due on autopay', async () => {
    // Stripe rejects it on a `charge_automatically` subscription - the
    // mirror of the rule above, and just as invisible without a real call.
    const calls = captureFetch()
    await provider().createSubscription({
      stripeCustomerId: 'cus_1',
      amountCents: 150_000,
      currency: 'usd',
      billingCycleAnchor: new Date('2026-09-01T14:00:00Z'),
      leaseId: 'lease_1',
      leasePayerId: 'payer_1',
      collectionMethod: 'charge_automatically',
    })
    const create = calls.find((c) => c.url.endsWith('/subscriptions'))!
    const body = String(create.init.body)
    expect(body).toContain('collection_method=charge_automatically')
    expect(body).not.toContain('days_until_due')
  })

  it('switches collection method WITHOUT an idempotency key', async () => {
    // An update is idempotent by nature, and a stale key would make a
    // legitimate switch back silently return the first switch's result -
    // leaving Stripe on one mode while we believed the other.
    const calls = captureFetch()
    await provider().setCollectionMethod({
      stripeSubscriptionId: 'sub_1',
      collectionMethod: 'send_invoice',
    })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBeUndefined()
    expect(String(calls[0]!.init.body)).toContain('collection_method=send_invoice')
  })

  it('asks only for OPEN invoices when reading what is still owed', async () => {
    // Not drafts: a draft invoice has not been presented to anybody, and
    // blocking a collection-method switch on one would refuse for a bill
    // that does not yet exist.
    const calls = captureFetch()
    await provider().getOpenInvoiceAmountCents({ stripeSubscriptionId: 'sub_1' })
    expect(calls[0]!.url).toContain('status=open')
    expect(calls[0]!.url).toContain('subscription=sub_1')
  })

  it('returns null - not zero - when the invoice list cannot be read', async () => {
    // `switchDecision` treats null as "we have not asked" and refuses. Zero
    // would mean "nothing owed" and ALLOW the switch, which is how a tenant
    // gets billed twice for one month.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ object: 'list' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    expect(
      await provider().getOpenInvoiceAmountCents({ stripeSubscriptionId: 'sub_1' }),
    ).toBeNull()
  })

  it('sums what is remaining across every open invoice', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: [{ amount_remaining: 150_000 }, { amount_remaining: 4_500 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    expect(await provider().getOpenInvoiceAmountCents({ stripeSubscriptionId: 'sub_1' })).toBe(
      154_500,
    )
  })

  it('charges the TOTAL core computed, and carries the caller’s idempotency key', async () => {
    // D-12: the card fee is core's arithmetic, and Stripe is handed a
    // finished number. The key is the caller's because a retried request
    // that timed out AFTER Stripe charged it must not become a second debit.
    const calls = captureFetch()
    await provider().createPaymentIntent({
      stripeCustomerId: 'cus_1',
      amountCents: 154_512,
      currency: 'usd',
      rail: 'CARD',
      leasePayerId: 'payer_1',
      leaseId: 'lease_1',
      idempotencyKey: 'pay:payer_1:154512:2026-09',
    })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe('pay:payer_1:154512:2026-09')
    const body = String(calls[0]!.init.body)
    expect(body).toContain('amount=154512')
    expect(body).toContain('payment_method_types%5B0%5D=card')
  })

  it('sends ACH as us_bank_account, the free rail', async () => {
    const calls = captureFetch()
    await provider().createPaymentIntent({
      stripeCustomerId: 'cus_1',
      amountCents: 150_000,
      currency: 'usd',
      rail: 'ACH',
      leasePayerId: 'payer_1',
      leaseId: 'lease_1',
      idempotencyKey: 'pay:payer_1:150000:2026-09',
    })
    expect(String(calls[0]!.init.body)).toContain('payment_method_types%5B0%5D=us_bank_account')
  })

  it('authenticates every call and pins the API version', async () => {
    const calls = captureFetch()
    await provider().getSubscription({ stripeSubscriptionId: 'sub_1' })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk_test_abc123')
    // Pinned, so Stripe changing its default does not change our behaviour
    // silently.
    expect(headers['Stripe-Version']).toBeTruthy()
  })

  describe('paymentMethodExpiry (R-045)', () => {
    it('reads a card’s expiry off the payment method', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ id: 'pm_1', card: { exp_month: 12, exp_year: 2027 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch
      expect(await provider().paymentMethodExpiry('pm_1')).toEqual({
        expMonth: 12,
        expYear: 2027,
      })
    })

    it('returns NULL for a bank-debit method, which has no expiry', async () => {
      // us_bank_account carries no `card` object at all - not an error, and
      // nothing to warn about.
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ id: 'pm_1', us_bank_account: { last4: '6789' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch
      expect(await provider().paymentMethodExpiry('pm_1')).toBeNull()
    })

    it('returns null rather than throwing for a payment method Stripe no longer has', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { message: 'No such payment_method' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch
      expect(await provider().paymentMethodExpiry('pm_gone')).toBeNull()
    })
  })
})
