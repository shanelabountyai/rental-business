import 'server-only'

import { auditAsSystem } from '@/lib/audit/system.ts'
import { CONSUMERS } from '@/lib/jobs/outbox.ts'

// "≤24h delist on lease-up" (LEASE-02, R-057, D-7) - the local half. Only
// flips OUR OWN row; telling each syndication network is delist-sweep.ts's
// job, deliberately kept out of this transaction - see that file's header
// for why a provider call never belongs inside one.
//
// Same shape as maintenance/triage-consumer.ts: react to the event, once,
// registered here, so none of the several ways a lease can go ACTIVE
// (a normal activation, an inherited-tenancy intake landing straight in
// ACTIVE) needs to remember to check for a listing itself.
CONSUMERS.push({
  name: 'delist-listing-on-lease-activation',
  event: 'lease.activated',
  handle: async (tx, event) => {
    const unitId =
      typeof event.payload === 'object' && event.payload !== null && 'unitId' in event.payload
        ? String((event.payload as { unitId: unknown }).unitId)
        : null
    if (!unitId) return

    const listing = await tx.listing.findFirst({
      where: { unitId, status: 'PUBLISHED' },
    })
    // Nothing published on this unit - the common case. Most units are
    // never listed at all, and a re-lease of a unit whose listing was
    // already taken down by hand has nothing left to do here.
    if (!listing) return

    await tx.listing.update({
      where: { id: listing.id },
      data: { status: 'UNPUBLISHED' },
    })

    await auditAsSystem(
      'lease-activated',
      {
        action: 'listing.unpublished',
        entityType: 'Listing',
        entityId: listing.id,
        propertyId: listing.propertyId,
        before: { status: 'PUBLISHED' },
        after: { status: 'UNPUBLISHED', reason: 'lease_activated' },
      },
      tx,
    )
  },
})
