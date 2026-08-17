// The syndication provider contract (LEASE-02, R-057; D-7: "SimulatedSyndicationAdapter...
// the contract fixture for future real drivers, including fault injection").
// One seam, matching the shape D-14 gave storage and notifications - see
// those files' own headers for why this repeats the pattern rather than
// inventing a new one.

import type { FeedEntry, SyndicationNetwork } from '@rental/core/listings'

export interface SyndicationListResult {
  /// The id the network assigned. Stored on ListingSyndication.externalId -
  /// never invented by us, and never read back from our own row either
  /// (D-27): it is genuinely what the provider said, the one fact only the
  /// provider can supply.
  externalId: string
}

/// What §14 of the master PRD asks every simulated adapter to be able to
/// produce: "timeout, malformed response, delayed webhook, partial failure."
/// Delayed webhook does not apply here - this adapter has no async callback,
/// only list()/delist() - so it is left out rather than modeled and unused.
export const SYNDICATION_FAULTS = ['timeout', 'malformed_response', 'partial_failure'] as const
export type SyndicationFault = (typeof SYNDICATION_FAULTS)[number]

export class SyndicationError extends Error {
  readonly code: SyndicationFault

  constructor(code: SyndicationFault, message: string) {
    super(message)
    this.name = 'SyndicationError'
    this.code = code
  }
}

export interface SyndicationAdapter {
  readonly name: string
  list(entry: FeedEntry): Promise<SyndicationListResult>
  delist(network: SyndicationNetwork, externalId: string): Promise<void>
}
