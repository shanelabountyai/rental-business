import 'server-only'

import { isSyndicationNetwork } from '@rental/core/listings'
import { prisma } from '@rental/db'

// Lead-source attribution (LEASE-02, R-057) - see ListingLead's own schema
// comment for why this stays a bare visit log rather than a real prospect
// record.

/**
 * Records one visit to the public listing page, tagged with whichever
 * network's tracked link brought it - or "direct" for anything else,
 * recorded rather than skipped so "how many visits had no attributable
 * source" stays answerable.
 *
 * Never throws into the page render - a lead-attribution write failing must
 * not be why a prospect cannot see the listing. Errors are logged and
 * swallowed, matching the fire-and-forget calls elsewhere in this codebase
 * (raiseBlockedNoticeTask's own comment gives the identical reasoning).
 */
export async function recordListingLead(listingId: string, rawSource: string | undefined): Promise<void> {
  const source = rawSource && isSyndicationNetwork(rawSource) ? rawSource : 'direct'
  await prisma.listingLead
    .create({ data: { listingId, source } })
    .catch((error) => {
      console.error(`[listings] failed to record a lead for ${listingId}`, error)
    })
}
