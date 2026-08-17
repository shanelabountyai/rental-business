import 'server-only'

import { type Document, type Listing, type Prisma, prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for Listing (LEASE-01, R-056).

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
