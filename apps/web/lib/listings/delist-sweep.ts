import 'server-only'

import type { SyndicationNetwork } from '@rental/core/listings'
import { prisma } from '@rental/db'
import type { SyndicationAdapter } from './adapter.ts'
import { syndicationAdapter } from './provider.ts'

// The network half of "≤24h delist on lease-up" (LEASE-02, R-057, D-7).
//
// Hourly, alongside the other elapsed-time sweeps (vendors/no-response.ts,
// comms/unanswered-sweep.ts) rather than a SCHEDULED_JOBS entry - this
// reconciles EXTERNAL state against a local fact that already changed
// (the listing went UNPUBLISHED), not a property-local calendar question.
//
// NEVER inside the transaction that unpublishes the listing
// (delist-consumer.ts). A provider call inside a database transaction holds
// a pooled connection open for the length of a third party's outage - the
// same rule apps/web/lib/notifications/send.ts's own header states for
// dispatchPendingNotifications(), applied here to a different provider. The
// simulated adapter would never actually make this matter, but the shape
// has to already be correct for the day a real driver (Phase 3,
// partner-gated) replaces it.
//
// SELF-HEALING BY CONSTRUCTION. The query condition
// (Listing.status = UNPUBLISHED AND ListingSyndication.status = LISTED) is
// still true after a failed delist attempt, so a network that faulted this
// hour is retried next hour with no separate retry bookkeeping - the same
// "the query IS the queue" shape sweepUnansweredDispatches already uses.

export interface DelistSweepResult {
  checked: number
  delisted: number
  failed: number
}

export async function sweepPendingDelists(
  /// Defaults to the wired provider; a test passes a fault-configured
  /// SimulatedSyndicationAdapter to prove the FAILED/retry path without a
  /// global toggle every other test would have to remember to reset.
  adapter: SyndicationAdapter = syndicationAdapter,
): Promise<DelistSweepResult> {
  const pending = await prisma.listingSyndication.findMany({
    where: { status: 'LISTED', listing: { status: 'UNPUBLISHED' } },
    select: { id: true, network: true, externalId: true },
  })

  let delisted = 0
  let failed = 0
  for (const row of pending) {
    if (!row.externalId) {
      // Never actually confirmed live (a LISTED row can only exist with one
      // - list() sets both together) - nothing to tell the network to take
      // down. Marked DELISTED rather than left LISTED forever with nothing
      // to retry.
      await prisma.listingSyndication.update({
        where: { id: row.id },
        data: { status: 'DELISTED', delistedAt: new Date() },
      })
      delisted += 1
      continue
    }
    try {
      await adapter.delist(row.network as SyndicationNetwork, row.externalId)
      await prisma.listingSyndication.update({
        where: { id: row.id },
        data: { status: 'DELISTED', delistedAt: new Date(), lastFaultCode: null },
      })
      delisted += 1
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
      await prisma.listingSyndication.update({
        where: { id: row.id },
        data: { lastFaultCode: code },
      })
      console.error(`[syndication] failed to delist ${row.id} from ${row.network}`, error)
      failed += 1
    }
  }

  return { checked: pending.length, delisted, failed }
}
