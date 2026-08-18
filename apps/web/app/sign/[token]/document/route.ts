import { prisma } from '@rental/db'
import { storage } from '@/lib/storage/index.ts'
import { verifySignerLink } from '@/lib/leases/sign-link.ts'

// Serves the lease PDF to a signer holding their own LEASE_SIGN link
// (LEASE-06, R-063).
//
// A SEPARATE ROUTE from api/documents/[id]/file, the same call
// vendor/[token]/documents/[documentId]/route.ts already made for a vendor's
// magic link - see that file's own header for why a token-authorized route
// stays physically apart from the two SESSION-authorized branches the other
// route checks, rather than becoming a third branch a session could fall
// through to.
//
// The token names the SIGNER, not the document - `verifySignerLink` already
// resolves which document (draft or executed) that signer may see, so this
// route trusts it rather than taking a document id from the URL at all.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const link = await verifySignerLink(token)
  if (!link.ok || !link.documentId) return new Response('Not found', { status: 404 })

  const document = await prisma.document.findUnique({ where: { id: link.documentId } })
  if (!document || document.deletedAt) return new Response('Not found', { status: 404 })

  const bytes = await storage.get(document.storageKey)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': document.contentType,
      'Content-Disposition': `inline; filename="${document.fileName.replace(/"/g, '')}"`,
      'Content-Length': String(bytes.byteLength),
      // `private` and short - a signing link is a bearer credential, same
      // as the vendor route's own reasoning.
      'Cache-Control': 'private, max-age=300',
    },
  })
}
