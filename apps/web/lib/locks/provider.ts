import 'server-only'

import type { IdentityAdapter, SmartLockAdapter } from './adapter.ts'
import { SimulatedIdentityAdapter, SimulatedSmartLockAdapter } from './simulated-adapter.ts'

// The wired adapters, in their own module for the same reason
// lib/esign/provider.ts and lib/screening/provider.ts are: swapping in a real
// driver later is a change to these two assignments and nothing else.
//
// A MODULE-LEVEL SINGLETON, and for the simulated lock that is load-bearing
// rather than incidental - the device's codes and its event log live in the
// adapter, so a second instance would be a second, empty lock. A real driver
// is stateless here and will not care.
//
// Typed as the interfaces, never the concrete classes.
export const smartLockAdapter: SmartLockAdapter = new SimulatedSmartLockAdapter()
export const identityAdapter: IdentityAdapter = new SimulatedIdentityAdapter()
