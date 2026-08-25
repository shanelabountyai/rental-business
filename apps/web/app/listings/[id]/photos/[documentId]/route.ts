import { prisma } from '@rental/db'
import { storage } from '@/lib/storage/index.ts'
import { documentResponse } from '@/lib/documents/serve.ts'

// Serves a unit photo for a PUBLISHED listing (LEASE-01, R-056).
//
// A SEPARATE ROUTE from api/documents/[id]/file, matching the reasoning the
// vendor photo route (vendor/[token]/documents/[documentId]/route.ts)
// already gives for the same split: that route authorizes a SESSION (two
// kinds); this authorizes PUBLICATION STATE, a third and different
// mechanism entirely, and keeping it separate means an anonymous request
// can never fall through to either session-authorized branch.
//
// PUBLIC, deliberately - unlike the vendor route (a bearer token in the
// path) this has no secret at all. The scope check is "does a PUBLISHED
// listing for this unit exist", which is the same authorization
// publicListing() already applies to the page itself.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  const { id, documentId } = await params

  const listing = await prisma.listing.findFirst({
    where: { id, status: 'PUBLISHED' },
    select: { unitId: true },
  })
  // 404 for everything, including a real listing that is no longer
  // published - "not public" and "does not exist" have to read the same to
  // an anonymous visitor, same as the page itself.
  if (!listing) return new Response('Not found', { status: 404 })

  const document = await prisma.document.findUnique({ where: { id: documentId } })
  if (
    !document ||
    document.deletedAt ||
    document.type !== 'UNIT_PHOTO' ||
    document.unitId !== listing.unitId
  ) {
    return new Response('Not found', { status: 404 })
  }

  const bytes = await storage.get(document.storageKey)
  // PUBLIC and long-lived, unlike the vendor route's private/short cache -
  // anyone may see a published listing's photos, and a CDN caching them is
  // exactly the behaviour a public listing page wants.
  return documentResponse(bytes, document, { cacheControl: 'public, max-age=3600' })
}
