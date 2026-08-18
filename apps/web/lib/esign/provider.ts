import 'server-only'

import type { EsignAdapter } from './adapter.ts'
import { SimulatedEsignAdapter } from './simulated-adapter.ts'

// The wired adapter, in its own module for the same reason
// lib/screening/provider.ts is - swapping in a real driver later (D-7:
// Phase 3, partner-gated on choosing an embedded e-sign vendor) is a change
// to this one assignment.
//
// Typed as the interface, not the concrete class - see EsignAdapter's own
// header.
export const esignAdapter: EsignAdapter = new SimulatedEsignAdapter()
