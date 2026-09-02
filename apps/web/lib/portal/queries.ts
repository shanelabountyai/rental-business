import 'server-only'

import type { TenantScope } from '@rental/core/portal'
import { prisma } from '@rental/db'

// Reads for the tenant portal (R-018). Every one of them is filtered by the
// tenant's own scope in the DATABASE QUERY, never by loading rows and hiding
// some in the template - DOC-03 asks for server-side enforcement, and a row
// that reached the browser is disclosed whatever the markup did with it.

/**
 * The SQL half of `tenantCanSeeDocument` (DOC-03), built once and shared by
 * every query below.
 *
 * The pure function is the readable statement of the rule and what the
 * permission tests exercise directly; this is the same rule expressed as SQL
 * so the database does the filtering rather than the template. They exist
 * twice by necessity, which is exactly the shape that drifts - so there is
 * ONE builder rather than the clause copy-pasted per query, and
 * `portal.test.ts` walks a whole fixture asserting the two agree row by row.
 */
function visibleDocumentWhere(scope: TenantScope) {
  return {
    deletedAt: null,
    OR: [
      { tenantId: scope.tenantId },
      // An empty leaseIds array makes this clause match nothing, which is
      // the correct answer for a tenant with no lease on file - not "match
      // every document with a null leaseId".
      { leaseId: { in: [...scope.leaseIds] } },
      // R-020's safety exception, kept to the one named type - see
      // tenantCanSeeDocument. `?? []` mirrors the predicate's own behaviour
      // for a scope built without unitIds: matches nothing.
      { type: 'SHUTOFF_PHOTO', unitId: { in: [...(scope.unitIds ?? [])] } },
    ],
  }
}

/// The documents this tenant may see (DOC-03).
export async function listTenantDocuments(scope: TenantScope) {
  return prisma.document.findMany({
    where: visibleDocumentWhere(scope),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      type: true,
      fileName: true,
      contentType: true,
      sizeBytes: true,
      createdAt: true,
    },
  })
}

/**
 * The home this tenant rents, from their most recent tenancy.
 *
 * Returns null when they have no lease at all - a record created ahead of a
 * tenancy, or an applicant. The portal says so plainly rather than rendering
 * an empty shell that looks broken.
 */
export async function getTenantHome(scope: TenantScope) {
  if (scope.leaseIds.length === 0) return null

  return prisma.lease.findFirst({
    where: { id: { in: [...scope.leaseIds] } },
    orderBy: { startsOn: 'desc' },
    select: {
      id: true,
      propertyId: true,
      status: true,
      startsOn: true,
      endsOn: true,
      rentCents: true,
      // R-066: whether notice has already been given, and how it ends -
      // added here rather than a second dedicated query, since a tenant's
      // own notice-to-vacate form needs exactly the same lease this page
      // already resolves as "the one home" and nothing else.
      noticeGivenAt: true,
      noticeGivenBy: true,
      noticeEffectiveOn: true,
      unit: { select: { name: true } },
      property: {
        select: {
          name: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          county: true,
          postalCode: true,
          timezone: true,
        },
      },
    },
  })
}

/**
 * Updates sent to this tenant on the PORTAL channel (R-016).
 *
 * This is what makes R-016's PORTAL channel real rather than theoretical: it
 * recorded the notification and called the record itself the delivery, on the
 * understanding that the portal would one day read it. This is that read.
 *
 * Only PORTAL - an email or text already reached them by its own route, and
 * echoing every one of those here would turn a short list of things that need
 * attention into a duplicate of their inbox.
 */
export async function listTenantUpdates(scope: TenantScope, limit = 20) {
  return prisma.notification.findMany({
    where: {
      recipientType: 'TENANT',
      recipientId: scope.tenantId,
      channel: 'PORTAL',
      // Suppressed and deferred rows are landlord-side bookkeeping about a
      // decision not to send; only what was actually delivered belongs here.
      delivery: { status: { in: ['SENT', 'DELIVERED', 'READ'] } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, subject: true, body: true, createdAt: true },
  })
}

/**
 * This tenant's conversation with the landlord (COMM-01, R-017).
 *
 * Scoped by `tenantId` on the Thread, not by property: R-017 keys a tenant
 * thread on both, and the tenant half of the pair is the one that identifies
 * whose conversation it is.
 */
export async function listTenantThreads(scope: TenantScope) {
  return prisma.thread.findMany({
    where: { tenantId: scope.tenantId },
    orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      lastMessageAt: true,
      property: { select: { name: true, timezone: true } },
      messages: {
        orderBy: { sentAt: 'desc' },
        take: 1,
        select: { body: true, sentAt: true, direction: true },
      },
    },
  })
}

export async function getTenantThread(id: string, scope: TenantScope) {
  return prisma.thread.findFirst({
    where: { id, tenantId: scope.tenantId },
    select: {
      id: true,
      property: { select: { name: true, timezone: true } },
      messages: {
        orderBy: { sentAt: 'asc' },
        select: {
          id: true,
          body: true,
          sentAt: true,
          direction: true,
          channel: true,
        },
      },
    },
  })
}
