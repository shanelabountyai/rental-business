import 'server-only'

import type { BillingProvider } from './adapter.ts'
import { SimulatedBillingProvider } from './simulated-adapter.ts'

// The wired provider, in its own module for the same reason
// lib/notifications/provider.ts is: so callers can import it without
// dragging in the module that imports them back.
//
// Typed as the interface, not the concrete class. The whole point of the
// seam is that wiring the real Stripe client later touches this one
// assignment - see adapter.ts's header for why that client is not written
// yet, and D-15 for the decision it follows.
export const billingProvider: BillingProvider = new SimulatedBillingProvider()

/// Whether billing is configured to talk to a real Stripe account.
///
/// Read per call rather than captured at module load, so the answer is
/// current. Used to LABEL things honestly on screen and in the ledger, never
/// to change behaviour: a code path that only runs against real Stripe is a
/// code path nothing has tested.
export function billingIsLive(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim())
}
