import { prisma } from '@rental/db'
import { verifyVerifyLink } from '@/lib/portal/verify-link.ts'
import { documentFileResponse } from '@/lib/documents/serve.ts'

// Serves a completion photo to a tenant holding a verify link (MAINT-07,
// R-142).
//
// A SEPARATE ROUTE from api/documents/[id]/file, and from the vendor and
// listing photo routes beside it, for the reason those two both already
// give: that route authorizes a SESSION and this authorizes a BEARER TOKEN,
// which is a different mechanism. A tenant answering "was this fixed?" has
// no session by construction — the whole point of the verify link is that
// R-021's phone-only persona could not get past the portal's email login.
//
// The token sits in the path, matching the page it is linked from, so the
// credential is never in a query string where it would be logged
// differently.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; documentId: string }> },
) {
  const { token, documentId } = await params

  const link = await verifyVerifyLink(token)
  // 404 for everything, including a valid token pointed at a document that
  // is not part of its job: "not yours" and "does not exist" have to be
  // indistinguishable, or the status code confirms a guessed id is real.
  // Same rule ROLE-01 applies to the staff side.
  if (!link.ok) return new Response('Not found', { status: 404 })

  const document = await prisma.document.findUnique({ where: { id: documentId } })
  if (!document || document.deletedAt) return new Response('Not found', { status: 404 })

  // THE SCOPE CHECK, and it is narrower than the vendor route's on purpose.
  // A vendor may read the ticket's photos too — the problem they were sent
  // to fix. A tenant asked "was this fixed?" is being shown the ANSWER, so
  // this is exactly the completion photos on exactly this work order.
  // Nothing on the ticket, nothing else at the unit, nothing they did not
  // already implicitly have (they photographed the problem themselves).
  if (document.workOrderId !== link.workOrderId || document.type !== 'COMPLETION_PHOTO') {
    return new Response('Not found', { status: 404 })
  }

  // `private` and short: a verify link is a bearer credential with a
  // seven-day life, and a shared cache holding these bytes would outlive it.
  return documentFileResponse(document, { cacheControl: 'private, max-age=300' })
}
