import { prisma } from '@rental/db'
import { storage } from '@/lib/storage/index.ts'
import { verifyVendorLink } from '@/lib/vendors/link.ts'

// Serves a document's bytes to a vendor holding a magic link (D-6, R-025).
//
// A SEPARATE ROUTE from api/documents/[id]/file rather than a third
// principal branch inside it, deliberately. That route authorizes two kinds
// of SESSION; a vendor has none, and authorizes with a bearer token instead
// - a different mechanism entirely. R-018's own lesson on that route was
// "the tenant side never falls through to the staff side"; adding a third
// path where an unauthenticated token could fall through to either is
// exactly the shape that lesson warns about. Keeping it separate means the
// vendor's scope check lives beside the vendor's other code and cannot be
// reached by anything holding a session instead.
//
// The token sits in the path, matching the page it is linked from, so the
// whole vendor surface is one prefix and the credential is never in a query
// string where it would be logged differently.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; documentId: string }> },
) {
  const { token, documentId } = await params

  const link = await verifyVendorLink(token)
  // 404 for everything, including a valid token pointed at a document that
  // is not part of its job: "not yours" and "does not exist" have to be
  // indistinguishable, or the status code confirms a guessed id is real.
  if (!link.ok) return new Response('Not found', { status: 404 })

  const document = await prisma.document.findUnique({ where: { id: documentId } })
  if (!document || document.deletedAt) return new Response('Not found', { status: 404 })

  // THE SCOPE CHECK. A vendor may read a document attached to their own work
  // order, or to the ticket that work order came from - the photos of the
  // problem they were sent to fix. Nothing else at the property, and nothing
  // at any other property. Matches vendorJobContext()'s own query exactly;
  // the two must stay in step, which is why both are written as the same
  // two-clause OR rather than one being "everything at the unit".
  const belongsToThisJob =
    document.workOrderId === link.workOrder.id ||
    (link.workOrder.ticketId != null && document.ticketId === link.workOrder.ticketId)
  if (!belongsToThisJob) return new Response('Not found', { status: 404 })

  const bytes = await storage.get(document.storageKey)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': document.contentType,
      'Content-Disposition': `inline; filename="${document.fileName.replace(/"/g, '')}"`,
      // From the bytes actually sent, not from the recorded size - see
      // api/documents/[id]/file's own comment for the bug that taught this.
      'Content-Length': String(bytes.byteLength),
      // `private` and short: a vendor link is a bearer credential, and a
      // shared cache holding these bytes would outlive the token that
      // authorized them.
      'Cache-Control': 'private, max-age=300',
    },
  })
}
