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

  it('authenticates every call and pins the API version', async () => {
    const calls = captureFetch()
    await provider().getSubscription({ stripeSubscriptionId: 'sub_1' })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk_test_abc123')
    // Pinned, so Stripe changing its default does not change our behaviour
    // silently.
    expect(headers['Stripe-Version']).toBeTruthy()
  })
})
