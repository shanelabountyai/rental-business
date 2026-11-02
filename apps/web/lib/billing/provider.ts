import 'server-only'

import type { BillingProvider } from './adapter.ts'
import { SimulatedBillingProvider } from './simulated-adapter.ts'
import { StripeBillingProvider } from './stripe-adapter.ts'
import { DEFAULT_ORG_ID } from '@/lib/auth/org.ts'
import { orgIntegration } from '@/lib/integrations/store.ts'
import { assertCanCollect } from '@/lib/integrations/stripe-onboarding.ts'

// The wired provider, in its own module for the same reason
// lib/notifications/provider.ts is: so callers can import it without
// dragging in the module that imports them back.
//
// SELECTED BY WHETHER A KEY IS CONFIGURED, and by nothing else. With
// `STRIPE_SECRET_KEY` set, this talks to Stripe; without it, to the
// simulator. There is deliberately no third mode and no override flag - a
// code path that only runs in one environment is a code path nothing has
// tested.
//
// `StripeBillingProvider` REFUSES A LIVE KEY at construction (D-26 is test
// mode only), which means a live key does not silently fall back to the
// simulator either - it throws on the first billing call, loudly, rather
// than letting somebody believe billing is running when it is not.

/**
 * The provider for ONE org's Stripe account (R-277a, D-316). Built per call
 * rather than cached, so an account connected a minute ago is the account
 * the next call uses.
 *
 * Direct charges: the platform key authenticates, and the org's connected
 * account rides on every request as `Stripe-Account` (resolved lazily by the
 * driver, from `connectedAccountId`). Without a key every org gets the
 * simulator, which emits its events as that org.
 */
export function getBillingProvider(orgId: string): BillingProvider {
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  return gated(orgId, key ? new StripeBillingProvider(key, () => stripeAccountFor(orgId)) : new SimulatedBillingProvider(orgId))
}

/**
 * The calls that START collecting: a new customer, subscription, saved
 * method, bill or charge (R-277b, PRD 10 §2.2). Refused, with an owner Task,
 * until the org's account is ENABLED - on both drivers, so the simulator
 * cannot collect where Stripe would not. Everything else passes: reads,
 * cancels and recording cash already in hand must keep working on a
 * restricted account, and the webhook must still project money that moved
 * before the restriction (D-11).
 */
const COLLECTING: ReadonlySet<string> = new Set<keyof BillingProvider>([
  'createCustomer',
  'createSubscription',
  'createSetupIntent',
  'resumeSubscription',
  'addInvoiceItem',
  'invoiceOneOffCharge',
  'addSubscriptionItem',
  'createPaymentIntent',
  'createApplicationFeeCustomer',
  'createApplicationFeePaymentIntent',
])

function gated(orgId: string, driver: BillingProvider): BillingProvider {
  return new Proxy(driver, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      // Bound to the driver: its `#private` fields refuse a Proxy as `this`.
      if (typeof prop !== 'string' || !COLLECTING.has(prop)) return value.bind(target)
      return async (...args: unknown[]) => {
        await assertCanCollect(orgId)
        return value.apply(target, args)
      }
    },
  })
}

export class NoConnectedAccountError extends Error {
  constructor(orgId: string) {
    super(`Org ${orgId} has no connected Stripe account; billing is refused until it connects one.`)
    this.name = 'NoConnectedAccountError'
  }
}

/**
 * The `Stripe-Account` header value for an org: its connected account, or
 * null for org #0 with no STRIPE row, which bills on the platform account
 * itself (the env credentials are org #0's alone, D-362). Any other org
 * without an account throws - there is no fallback to the platform's
 * account, which would bank one org's rent in another's name.
 */
async function stripeAccountFor(orgId: string): Promise<string | null> {
  const accountId = await connectedAccountId(orgId)
  if (accountId) return accountId
  if (orgId === DEFAULT_ORG_ID) return null
  throw new NoConnectedAccountError(orgId)
}

/// The org's connected account id, or null. Also what the browser passes to
/// `loadStripe(pk, { stripeAccount })` (PRD 10 §2.3).
export async function connectedAccountId(orgId: string): Promise<string | null> {
  const row = await orgIntegration(orgId, 'STRIPE')
  const accountId = row?.config.accountId
  return typeof accountId === 'string' && accountId ? accountId : null
}

/// Whether billing is configured to talk to a real Stripe account.
///
/// Read per call rather than captured at module load, so the answer is
/// current. Used to LABEL things honestly on screen and in the ledger, never
/// to change behaviour.
export function billingIsLive(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim())
}

/// The provider's own name, for display. Reads through the selector so a
/// screen cannot report one provider while another is doing the work.
export function billingProviderName(): string {
  return getBillingProvider(DEFAULT_ORG_ID).name
}
