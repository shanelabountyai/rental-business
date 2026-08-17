// The feed builder (LEASE-02, R-057): turning a listing into the shape a
// syndication network needs. Pure - no database, no provider, no adapter.
//
// No feed standard (RETS, RESO Web API, an ILS XML feed) is named anywhere
// in the PRD or backlog - this is an open implementation choice, resolved
// here as a plain typed object rather than a format literal, since the
// SIMULATED adapter (D-7) never actually serializes to XML/JSON for a real
// network. A real driver, when one exists (Phase 3, partner-gated), maps
// this shape to whatever that network's feed format actually requires - the
// mapping is the driver's job, not this one's.

export const SYNDICATION_NETWORKS = ['ZILLOW', 'APARTMENTS_COM', 'ZUMPER'] as const
export type SyndicationNetwork = (typeof SYNDICATION_NETWORKS)[number]

const NETWORK_SET: ReadonlySet<string> = new Set(SYNDICATION_NETWORKS)

export function isSyndicationNetwork(value: string): value is SyndicationNetwork {
  return NETWORK_SET.has(value)
}

export interface FeedListingInput {
  id: string
  headline: string | null
  description: string | null
  rentCents: number
  depositCents: number | null
  /// Business date (YYYY-MM-DD) - callers read this off the @db.Date column
  /// with utcToBusinessDate, never a timezone-converted instant (D-3).
  availableOn: string
  requirements: string | null
  petsAllowed: boolean
  petPolicyText: string | null
  addressLine1: string
  city: string
  state: string
  postalCode: string
  bedrooms: number | null
  bathrooms: number | null
  squareFeet: number | null
  /// Public photo URLs, already resolved by the caller (the dedicated
  /// public route R-056 built, listings/[id]/photos/[documentId]) - this
  /// module has no storage access to resolve them itself.
  photoUrls: readonly string[]
}

export interface FeedEntry {
  network: SyndicationNetwork
  /// What we call this listing when we tell the network about it - not the
  /// network's own id, which does not exist until `list()` returns one.
  externalRef: string
  /// Path only (no origin) to the tracked public page - the caller
  /// prepends whatever base URL is live in that environment. Every network
  /// gets its OWN tracked link, which is the entire mechanism behind
  /// "inbound leads carry source attribution" (LEASE-02): a visitor who
  /// arrives via this exact link is attributable to this exact network.
  trackedPath: string
  headline: string
  description: string
  rentCents: number
  depositCents: number | null
  availableOn: string
  requirements: string | null
  petsAllowed: boolean
  petPolicyText: string | null
  address: {
    line1: string
    city: string
    state: string
    postalCode: string
  }
  bedrooms: number | null
  bathrooms: number | null
  squareFeet: number | null
  photoUrls: readonly string[]
}

export function buildFeedEntry(
  listing: FeedListingInput,
  network: SyndicationNetwork,
): FeedEntry {
  return {
    network,
    externalRef: `listing:${listing.id}`,
    trackedPath: `/listings/${listing.id}?src=${network}`,
    headline: listing.headline || `${listing.addressLine1}, ${listing.city}`,
    description: listing.description ?? '',
    rentCents: listing.rentCents,
    depositCents: listing.depositCents,
    availableOn: listing.availableOn,
    requirements: listing.requirements,
    petsAllowed: listing.petsAllowed,
    petPolicyText: listing.petPolicyText,
    address: {
      line1: listing.addressLine1,
      city: listing.city,
      state: listing.state,
      postalCode: listing.postalCode,
    },
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    squareFeet: listing.squareFeet,
    photoUrls: listing.photoUrls,
  }
}

/// Every network a listing is currently meant to reach, as feed entries -
/// what the "syndicate" action builds one FeedEntry per network from.
export function buildFeed(
  listing: FeedListingInput,
  networks: readonly SyndicationNetwork[],
): FeedEntry[] {
  return networks.map((network) => buildFeedEntry(listing, network))
}
