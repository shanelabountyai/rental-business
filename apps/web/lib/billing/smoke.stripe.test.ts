import { describe, expect, it } from 'vitest'
import { StripeBillingProvider } from './stripe-adapter.ts'

// A ONE-OFF smoke test against real Stripe TEST MODE.
//
// Not part of the suite: vitest.config.ts pins STRIPE_SECRET_KEY to empty so
// the 1,200-odd tests stay deterministic and offline. This reads the key from
// STRIPE_SMOKE_KEY instead, which nothing pins, and skips itself when that is
// absent - so it is inert for everybody who has not deliberately set it.
//
// It exists to answer the question standing since R-036: has this driver ever
// been executed at all? Everything up to the HTTP call was tested; the call
// itself never was.

const key = process.env.STRIPE_SMOKE_KEY
const when = key ? describe : describe.skip

when('the real Stripe driver, against test mode', () => {
  const provider = () => new StripeBillingProvider(key!)

  it('authenticates and creates a customer', async () => {
    const result = await provider().createCustomer({
      leasePayerId: `smoke_${Date.now()}`,
      leaseId: 'smoke_lease',
      propertyId: 'smoke_property',
      name: 'Smoke Test (safe to delete)',
      email: null,
      phone: null,
    })
    expect(result.stripeCustomerId).toMatch(/^cus_/)
  })

  it('returns null for a subscription that does not exist, rather than throwing', async () => {
    // The 404 path. `getSubscription` is called on every re-sync, so a
    // subscription deleted in the dashboard must not take the screen down.
    expect(
      await provider().getSubscription({ stripeSubscriptionId: 'sub_doesnotexist0000' }),
    ).toBeNull()
  })

  it('walks the whole subscription lifecycle Stripe actually accepts', async () => {
    // THE REQUEST SHAPES, against the only thing that can judge them. These
    // are the parameters unit tests can only assert we SENT: the anchor in
    // seconds rather than milliseconds, `days_until_due` required on
    // send_invoice and rejected on charge_automatically, proration_behavior,
    // and the collection-method switch itself.
    const stamp = Date.now()
    const customer = await provider().createCustomer({
      leasePayerId: `smoke_${stamp}`,
      leaseId: `smoke_lease_${stamp}`,
      propertyId: 'smoke_property',
      name: 'Smoke Lifecycle (safe to delete)',
      // An email, because Stripe REFUSES send_invoice without one - which is
      // itself a finding this test produced. See the switch guard.
      email: `smoke+${stamp}@example.test`,
      phone: null,
    })

    // Anchored a few days out, in seconds. Milliseconds would put it about
    // fifty thousand years ahead and Stripe would reject it.
    const anchor = new Date(Date.now() + 5 * 86_400_000)
    const subscription = await provider().createSubscription({
      stripeCustomerId: customer.stripeCustomerId,
      amountCents: 150_000,
      currency: 'usd',
      billingCycleAnchor: anchor,
      leaseId: `smoke_lease_${stamp}`,
      leasePayerId: `smoke_${stamp}`,
      collectionMethod: 'charge_automatically',
    })
    expect(subscription.stripeSubscriptionId).toMatch(/^sub_/)
    expect(subscription.stripePriceId).toMatch(/^price_/)

    const read = await provider().getSubscription({
      stripeSubscriptionId: subscription.stripeSubscriptionId,
    })
    expect(read?.amountCents).toBe(150_000)

    // D-29's switch. `send_invoice` REQUIRES days_until_due; Stripe rejects
    // the request without it, and rejects it on charge_automatically.
    await provider().setCollectionMethod({
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      collectionMethod: 'send_invoice',
    })
    await provider().setCollectionMethod({
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      collectionMethod: 'charge_automatically',
    })

    // The read the switch guard refuses without.
    const open = await provider().getOpenInvoiceAmountCents({
      stripeSubscriptionId: subscription.stripeSubscriptionId,
    })
    expect(open).not.toBeNull()

    // A rent change: a new immutable Price, no proration.
    await provider().updateSubscriptionPrice({
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      amountCents: 165_000,
      currency: 'usd',
      leaseId: `smoke_lease_${stamp}`,
    })

    // Tidy up after ourselves in the test account.
    await provider().cancelSubscription({
      stripeSubscriptionId: subscription.stripeSubscriptionId,
    })
  }, 60_000)

  it('reports a real Stripe error rather than swallowing it', async () => {
    await expect(
      provider().addInvoiceItem({
        stripeCustomerId: 'cus_doesnotexist0000',
        amountCents: 100,
        currency: 'usd',
        description: 'smoke',
        idempotencyKey: `smoke:${Date.now()}`,
      }),
    ).rejects.toThrow()
  })
})
