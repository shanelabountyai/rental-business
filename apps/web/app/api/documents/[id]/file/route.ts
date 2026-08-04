import { prisma } from '@rental/db'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { storage } from '@/lib/storage/index.ts'

// Serves a Document's bytes (DOC-01). `redirect()` (inside requirePermission)
// works from a Route Handler the same as a Server Component or Action - an
// unauthenticated request lands on /login, an out-of-scope one on /no-access,
// same as everywhere else in the admin shell, rather than this route
// inventing its own response shape for the same two cases.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const document = await prisma.document.findUnique({
    where: { id },
    include: { property: { select: { id: true, legalEntityId: true } } },
  })
  if (!document || !document.property) {
    return new Response('Not found', { status: 404 })
  }

  await requirePermission('document.read', propertyResource(document.property))

  const bytes = await storage.get(document.storageKey)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': document.contentType,
      'Content-Disposition': `inline; filename="${document.fileName.replace(/"/g, '')}"`,
      'Content-Length': String(document.sizeBytes),
      // Documents can be re-uploaded under a fresh id (no in-place edits), so
      // caching an old id's bytes forever is safe - but each Document row is
      // itself immutable, so this is never invalidated by a change.
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
