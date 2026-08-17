import 'server-only'

import { randomBytes } from 'node:crypto'
import type { FeedEntry, SyndicationNetwork } from '@rental/core/listings'
import {
  type SyndicationAdapter,
  type SyndicationFault,
  SyndicationError,
} from './adapter.ts'

// The simulated syndication provider (D-7's simulated-adapter convention,
// R-057) - same posture as apps/web/lib/billing/simulated-adapter.ts, whose
// own header this restates for a second D-7 adapter family:
//
// MINTS IDS IN A REALISTIC SHAPE, not `sim-1` - so nothing downstream can
// depend on the difference between this and a real driver's response.
//
// LOUD ABOUT WHAT IT IS: every call is logged with a `[syndication:simulated]`
// prefix and `name` says `simulated`, so no screen or log line can be
// mistaken for a real network having actually been contacted.
//
// HOLDS NO STATE OF ITS OWN. "Is this listing live on Zillow" is answered by
// `ListingSyndication` - our own row, holding what the provider last told us
// (D-27) - never by an in-memory registry here. A restart forgets nothing,
// because there is nothing here to forget.
//
// FAULT INJECTION IS A CONSTRUCTOR SEAM, not a global toggle. §14 of the
// master PRD asks for "timeout, malformed response, delayed webhook, partial
// failure" so error paths are exercised in CI rather than discovered in
// production - `fault` is how a test does that, deterministically, without
// an env var every other test would have to remember to unset.

function providerId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

export class SimulatedSyndicationAdapter implements SyndicationAdapter {
  readonly name = 'simulated'

  constructor(
    private readonly opts: {
      /// Called before every list()/delist(). Returning a fault code makes
      /// that call throw a SyndicationError instead of succeeding.
      fault?: (network: SyndicationNetwork, op: 'list' | 'delist') => SyndicationFault | null
    } = {},
  ) {}

  async list(entry: FeedEntry): Promise<{ externalId: string }> {
    const fault = this.opts.fault?.(entry.network, 'list')
    if (fault) {
      console.info(
        `[syndication:simulated] FAULT (${fault}) listing ${entry.externalRef} on ${entry.network}`,
      )
      throw new SyndicationError(
        fault,
        `Simulated ${fault} listing ${entry.externalRef} on ${entry.network}.`,
      )
    }
    const externalId = providerId(entry.network.toLowerCase())
    console.info(
      `[syndication:simulated] listed ${entry.externalRef} on ${entry.network} as ${externalId}`,
    )
    return { externalId }
  }

  async delist(network: SyndicationNetwork, externalId: string): Promise<void> {
    const fault = this.opts.fault?.(network, 'delist')
    if (fault) {
      console.info(
        `[syndication:simulated] FAULT (${fault}) delisting ${externalId} from ${network}`,
      )
      throw new SyndicationError(
        fault,
        `Simulated ${fault} delisting ${externalId} from ${network}.`,
      )
    }
    console.info(`[syndication:simulated] delisted ${externalId} from ${network}`)
  }
}
