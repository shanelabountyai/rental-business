import 'server-only'

import type { ScreeningAdapter } from './adapter.ts'
import { SimulatedScreeningAdapter } from './simulated-adapter.ts'

// The wired adapter, in its own module for the same reason
// lib/listings/provider.ts is - swapping in a real driver later (D-7: Phase
// 3, partner-gated on a screening vendor agreement) is a change to this one
// assignment.
//
// Typed as the interface, not the concrete class - see ScreeningAdapter's
// own header.
export const screeningAdapter: ScreeningAdapter = new SimulatedScreeningAdapter()
