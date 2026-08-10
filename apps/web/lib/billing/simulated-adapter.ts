import 'server-only'

import { randomBytes } from 'node:crypto'
import type {
  BillingProvider,
  CustomerInput,
  ProvisionedCustomer,
  ProvisionedSetupIntent,
  ProvisionedSubscription,
  SubscriptionInput,
} from './adapter.ts'

// The simulated billing provider (D-7's simulated-adapter convention, R-034).
//
// Mints ids in Stripe's own shape - `cus_`, `sub_`, `price_`, `seti_`, plus
// the `_secret_` suffix a SetupIntent client secret carries - so that every
// column, index, log line and screen downstream is exercised against
// realistic values. An id shaped like `sim-1` would let a length assumption
// or a prefix check pass here and fail the day real ones arrive.
//
// LOUD ABOUT WHAT IT IS. It logs every call, and `name` says `simulated` so
// any screen or log showing the provider says so too. A simulator nobody can
// tell apart from the real thing is how a staging environment gets mistaken
// for production.
//
// It does NOT hold state. Whether a customer "exists" is a question about
// our own database, which records the id it was given - and a simulator with
// its own in-memory registry would answer a different question than
// production would, which is the exact way a simulator starts lying.

function stripeId(prefix: string): string {
  // 24 base36-ish characters, matching the shape of a real Stripe id closely
  // enough that nothing downstream can depend on the difference.
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

export class SimulatedBillingProvider implements BillingProvider {
  readonly name = 'simulated'

  async createCustomer(input: CustomerInput): Promise<ProvisionedCustomer> {
    const stripeCustomerId = stripeId('cus')
    console.info(
      `[billing:simulated] customer ${stripeCustomerId} for payer ${input.leasePayerId} (${input.name})`,
    )
    return { stripeCustomerId }
  }

  async createSubscription(input: SubscriptionInput): Promise<ProvisionedSubscription> {
    const stripePriceId = stripeId('price')
    const stripeSubscriptionId = stripeId('sub')
    console.info(
      `[billing:simulated] subscription ${stripeSubscriptionId} at ${input.amountCents}c ` +
        `anchored ${input.billingCycleAnchor.toISOString()} for payer ${input.leasePayerId}`,
    )
    return { stripeSubscriptionId, stripePriceId }
  }

  async createSetupIntent(stripeCustomerId: string): Promise<ProvisionedSetupIntent> {
    const setupIntentId = stripeId('seti')
    console.info(`[billing:simulated] setup intent ${setupIntentId} for ${stripeCustomerId}`)
    return {
      setupIntentId,
      clientSecret: `${setupIntentId}_secret_${randomBytes(8).toString('hex')}`,
    }
  }
}
