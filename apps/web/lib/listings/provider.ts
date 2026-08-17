import 'server-only'

import type { SyndicationAdapter } from './adapter.ts'
import { SimulatedSyndicationAdapter } from './simulated-adapter.ts'

// The wired adapter, in its own module for the same reason
// notifications/provider.ts and storage/index.ts each are: swapping in a
// real driver later (D-7: Phase 3, partner-gated on an aggregator
// agreement) is a change to this one assignment.
//
// Typed as the interface, not the concrete class - see SyndicationAdapter's
// own header.
export const syndicationAdapter: SyndicationAdapter = new SimulatedSyndicationAdapter()
