'use server'

import { type SyndicationNetwork, buildFeed, isSyndicationNetwork } from '@rental/core/listings'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { feedListingContextFor } from './queries.ts'
import { syndicationAdapter } from './provider.ts'

// Syndicating a published listing to networks (LEASE-02, R-057).
//
// `unit.write` again - same reasoning as apps/web/lib/listings/actions.ts's
// own header: syndication is a fact about the unit's listing, not a
// privilege tier of its own.

export interface SyndicationFormState {
  error?: string
  notice?: string
}

/**
 * Sends a PUBLISHED listing to the requested networks.
 *
 * One network's failure never blocks another's - the loop keeps going and
 * each row records its own outcome (D-7's "partial failure" fault is the
 * literal case this exists to survive). A network already LISTED is skipped
 * silently: re-selecting it in the form is idempotent, not a re-send.
 */
export async function syndicateListing(
  listingId: string,
  _previous: SyndicationFormState,
  formData: FormData,
): Promise<SyndicationFormState> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: { property: true },
  })
  if (!listing) return { error: 'That listing no longer exists.' }
  await requirePermission('unit.write', propertyResource(listing.property))

  if (listing.status !== 'PUBLISHED') {
    return {
      error: 'Publish the listing before syndicating it - a network should never carry a draft.',
    }
  }

  const requested = formData
    .getAll('networks')
    .map(String)
    .filter(isSyndicationNetwork)
  if (requested.length === 0) {
    return { error: 'Choose at least one network.' }
  }

  const context = await feedListingContextFor(listingId)
  if (!context) return { error: 'That listing no longer exists.' }

  const existing = await prisma.listingSyndication.findMany({
    where: { listingId, network: { in: requested } },
  })
  const alreadyListed = new Set(
    existing.filter((row) => row.status === 'LISTED').map((row) => row.network),
  )
  const toSend = requested.filter(
    (network) => !alreadyListed.has(network),
  ) as SyndicationNetwork[]

  let sent = 0
  let failed = 0
  for (const entry of buildFeed(context.input, toSend)) {
    try {
      const result = await syndicationAdapter.list(entry)
      await prisma.listingSyndication.upsert({
        where: { listingId_network: { listingId, network: entry.network } },
        create: {
          listingId,
          network: entry.network,
          status: 'LISTED',
          externalId: result.externalId,
          listedAt: new Date(),
        },
        update: {
          status: 'LISTED',
          externalId: result.externalId,
          listedAt: new Date(),
          lastFaultCode: null,
          delistedAt: null,
        },
      })
      sent += 1
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
      await prisma.listingSyndication.upsert({
        where: { listingId_network: { listingId, network: entry.network } },
        create: { listingId, network: entry.network, status: 'FAILED', lastFaultCode: code },
        update: { status: 'FAILED', lastFaultCode: code },
      })
      console.error(`[syndication] failed to list ${listingId} on ${entry.network}`, error)
      failed += 1
    }
  }

  revalidatePath(`/properties/${context.propertyId}/units/${context.unitId}/listing/${listingId}`)

  if (sent === 0 && failed > 0) {
    return { error: 'Every network failed. Check the log and try again.' }
  }
  return {
    notice:
      failed > 0
        ? `Sent to ${sent} network${sent === 1 ? '' : 's'}; ${failed} failed.`
        : `Sent to ${sent} network${sent === 1 ? '' : 's'}.`,
  }
}
