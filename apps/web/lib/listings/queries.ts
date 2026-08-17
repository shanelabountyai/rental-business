import 'server-only'

import type { FeedListingInput } from '@rental/core/listings'
import { utcToBusinessDate } from '@rental/core/scheduling'
import {
  type Document,
  type Listing,
  type ListingSyndication,
  type Prisma,
  prisma,
} from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for Listing (LEASE-01, R-056; LEASE-02, R-057).

/// The most recent listing for a unit, any status - what the admin unit page
/// shows. A unit can be listed more than once over its life (re-listed after
/// each vacancy); this is always the current one, and an UNPUBLISHED result
/// is the signal the unit page uses to offer "create a new listing" rather
/// than resurrecting a stale one.
export async function listingForUnit(
  unitId: string,
  scope: ResolvedScope,
): Promise<Listing | null> {
  const listing = await prisma.listing.findFirst({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
  })
  if (!listing || !scope.propertyIds.includes(listing.propertyId)) return null
  return listing
}

export async function listingForWrite(
  listingId: string,
  scope: ResolvedScope,
): Promise<Listing | null> {
  const listing = await prisma.listing.findUnique({ where: { id: listingId } })
  if (!listing || !scope.propertyIds.includes(listing.propertyId)) return null
  return listing
}

export interface PublicListing extends Listing {
  property: { addressLine1: string; city: string; state: string; postalCode: string; timezone: string; county: string | null }
  unit: { name: string; bedrooms: number | null; bathrooms: Prisma.Decimal | null; squareFeet: number | null }
}

/// The hosted page's own read - PUBLISHED ONLY, no actor, no scope. A
/// DRAFT or UNPUBLISHED listing must be indistinguishable from one that does
/// not exist to an anonymous visitor, the same "not yours and does not
/// exist read the same" rule every other public/token-gated route in this
/// product already follows (ROLE-01's own 404-not-403 posture, applied here
/// to "not public" rather than "not yours").
export async function publicListing(id: string): Promise<PublicListing | null> {
  const listing = await prisma.listing.findFirst({
    where: { id, status: 'PUBLISHED' },
    include: {
      property: {
        select: { addressLine1: true, city: true, state: true, postalCode: true, timezone: true, county: true },
      },
      unit: { select: { name: true, bedrooms: true, bathrooms: true, squareFeet: true } },
    },
  })
  return listing
}

/// Live from the unit's own photo library (R-012), never copied onto the
/// listing - see Listing's own schema comment for why.
export async function unitPhotosForListing(unitId: string): Promise<Document[]> {
  return prisma.document.findMany({
    where: { unitId, type: 'UNIT_PHOTO', deletedAt: null },
    orderBy: { capturedAt: 'asc' },
  })
}

export interface FeedListingContext {
  input: FeedListingInput
  propertyId: string
  unitId: string
}

/// Assembles what packages/core/listings/feed.ts needs from the DB rows
/// it cannot see - the feed builder itself stays pure. Shared by the
/// syndicate action and anything that wants to preview the feed before
/// sending it.
export async function feedListingContextFor(listingId: string): Promise<FeedListingContext | null> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: { property: true, unit: true },
  })
  if (!listing) return null

  const photos = await unitPhotosForListing(listing.unitId)

  return {
    propertyId: listing.propertyId,
    unitId: listing.unitId,
    input: {
      id: listing.id,
      headline: listing.headline,
      description: listing.description,
      rentCents: listing.rentCents,
      depositCents: listing.depositCents,
      availableOn: utcToBusinessDate(listing.availableOn),
      requirements: listing.requirements,
      petsAllowed: listing.petsAllowed,
      petPolicyText: listing.petPolicyText,
      addressLine1: listing.property.addressLine1,
      city: listing.property.city,
      state: listing.property.state,
      postalCode: listing.property.postalCode,
      bedrooms: listing.unit.bedrooms,
      bathrooms: listing.unit.bathrooms != null ? Number(listing.unit.bathrooms) : null,
      squareFeet: listing.unit.squareFeet,
      photoUrls: photos.map((photo) => `/listings/${listing.id}/photos/${photo.id}`),
    },
  }
}

export async function listingSyndications(listingId: string): Promise<ListingSyndication[]> {
  return prisma.listingSyndication.findMany({
    where: { listingId },
    orderBy: { network: 'asc' },
  })
}

/// Visits by source (LEASE-02's "inbound leads carry source attribution"),
/// for the admin screen - the one place this data is read back today.
export async function leadCountsForListing(
  listingId: string,
): Promise<{ source: string; count: number }[]> {
  const rows = await prisma.listingLead.groupBy({
    by: ['source'],
    where: { listingId },
    _count: { source: true },
    orderBy: { source: 'asc' },
  })
  return rows.map((row) => ({ source: row.source, count: row._count.source }))
}
