import 'server-only'

import type { TenantScope } from '@rental/core/portal'
import { prisma } from '@rental/db'

// Reads for the tenant portal (R-018). Every one of them is filtered by the
// tenant's own scope in the DATABASE QUERY, never by loading rows and hiding
// some in the template - DOC-03 asks for server-side enforcement, and a row
// that reached the browser is disclosed whatever the markup did with it.

/**
 * The documents this tenant may see (DOC-03).
 *
 * The `where` mirrors `tenantCanSeeDocument` exactly - allow-list on
 * `tenantId` or `leaseId`, never `propertyId`. The pure function is the
 * readable statement of the rule and what the permission tests exercise
 * directly; this is the same rule expressed as SQL so the database does the
 * filtering. `portal.test.ts` asserts the two agree, because two expressions
 * of one rule is exactly the shape that drifts.
 */
export async function listTenantDocuments(scope: TenantScope) {
  return prisma.document.findMany({
    where: {
      deletedAt: null,
      OR: [
        { tenantId: scope.tenantId },
        // An empty leaseIds array makes this clause match nothing, which is
        // the correct answer for a tenant with no lease on file - not "match
        // every document with a null leaseId".
        { leaseId: { in: [...scope.leaseIds] } },
      ],
    },
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

/// One document, or null if it is not theirs. Null rather than a thrown
/// error: "not yours" and "does not exist" must be indistinguishable, or the
/// response confirms a document id belongs to somebody.
export async function getTenantDocument(id: string, scope: TenantScope) {
  return prisma.document.findFirst({
    where: {
      id,
      deletedAt: null,
      OR: [
        { tenantId: scope.tenantId },
        { leaseId: { in: [...scope.leaseIds] } },
      ],
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
      status: true,
      startsOn: true,
      endsOn: true,
      rentCents: true,
      unit: { select: { name: true } },
      property: {
        select: {
          name: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
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
