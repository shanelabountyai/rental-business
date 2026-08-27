import { tenantCanSeeDocument } from '@rental/core/portal'
import { prisma } from '@rental/db'
import { auth } from '@/auth.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { tenantScope } from '@/lib/portal/guard.ts'
import { documentFileResponse } from '@/lib/documents/serve.ts'

// Serves a Document's bytes (DOC-01, DOC-03). `redirect()` (inside
// requirePermission) works from a Route Handler the same as a Server
// Component or Action - an unauthenticated request lands on /login, an
// out-of-scope one on /no-access, same as everywhere else in the admin shell,
// rather than this route inventing its own response shape for the same cases.
//
// TWO PRINCIPALS REACH THIS ROUTE, authorized by completely different rules.
// R-018 added the tenant half; before it, the only check here was staff RBAC,
// so a tenant clicking their own lease was bounced to the STAFF sign-in page.
//
// The branch is on the session's own `kind`, and the tenant side never falls
// through to the staff side. A principal that is neither ends at
// requirePermission, which refuses - the correct default for a route that
// hands over bytes is that an unrecognised caller gets nothing.

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
  if (!document) {
    return new Response('Not found', { status: 404 })
  }

  const session = await auth()

  if (session?.principal.kind === 'tenant') {
    const scope = await tenantScope(session.principal.id)
    if (!tenantCanSeeDocument(document, scope)) {
      // 404, not 403. "Not yours" and "does not exist" must be
      // indistinguishable, or the status code confirms that a guessed id
      // belongs to somebody at the address this tenant rents.
      return new Response('Not found', { status: 404 })
    }
    return serve(document)
  }

  // Staff: R-004's property-scoped RBAC. A document with NEITHER a property
  // nor an entity has no resource to scope against, so it is refused rather
  // than waved through.
  //
  // The entity branch is R-081d's. Before it, `Document.legalEntityId` did not
  // exist and this route's only question was "which property" - so an
  // entity-level artifact (the year-end tax packet, an entity-level compliance
  // completion) was unreachable to everybody, including the owner who produced
  // it. `assignmentCovers` picks ONE branch per assignment and never falls
  // back, which is why the entity id is passed on both paths.
  if (document.property) {
    await requirePermission('document.read', propertyResource(document.property))
    return serve(document)
  }
  if (document.legalEntityId) {
    await requirePermission('document.read', { legalEntityId: document.legalEntityId })
    return serve(document)
  }
  return new Response('Not found', { status: 404 })
}

async function serve(document: {
  storageKey: string
  contentType: string
  fileName: string
}) {
  // No Cache-Control: this route answers for every document in the product,
  // scoped per request by session and permission, so there is no one cache
  // policy that is right for all of them.
  return documentFileResponse(document)
}
