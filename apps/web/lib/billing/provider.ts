import 'server-only'

import type { BillingProvider } from './adapter.ts'
import { SimulatedBillingProvider } from './simulated-adapter.ts'
import { StripeBillingProvider } from './stripe-adapter.ts'

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

function selectProvider(): BillingProvider {
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key) return new SimulatedBillingProvider()
  return new StripeBillingProvider(key)
}

/// Constructed lazily and cached, so a deployment with no key never
/// constructs the Stripe driver, and one with a bad key fails at the first
/// billing call rather than at import time - which would take down every
/// page, including the ones that would tell somebody what is wrong.
let cached: BillingProvider | null = null

export function getBillingProvider(): BillingProvider {
  cached ??= selectProvider()
  return cached
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
  return getBillingProvider().name
}
