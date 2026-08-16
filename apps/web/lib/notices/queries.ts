import 'server-only'

import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/types.ts'

// Reads for notices and their service records (COMM-02, R-051). Scoped by
// ResolvedScope like every other staff read - the switcher's selection
// already intersected with RBAC.

const noticeInclude = {
  property: { select: { id: true, name: true, timezone: true, state: true, county: true } },
  lease: {
    select: {
      id: true,
      unit: { select: { id: true, name: true } },
      leaseTenants: {
        orderBy: { isPrimary: 'desc' },
        select: { tenant: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  },
  document: { select: { id: true, fileName: true, sizeBytes: true } },
  deliveries: {
    orderBy: { servedAt: 'asc' },
    include: {
      servedBy: { select: { id: true, name: true } },
      proofDocument: {
        select: { id: true, fileName: true, contentType: true, capturedAt: true },
      },
    },
  },
} as const

export type NoticeWithDeliveries = Awaited<ReturnType<typeof getNotice>>

/// Every notice in scope, newest first. Unserved ones lead, because a
/// generated-but-not-served notice is work somebody still has to do and a
/// served one is a record.
export async function listNotices(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  const notices = await prisma.notice.findMany({
    where: { propertyId: { in: scope.propertyIds } },
    include: noticeInclude,
    orderBy: { generatedAt: 'desc' },
  })
  return notices.sort((a, b) => {
    const aServed = a.servedAt ? 1 : 0
    const bServed = b.servedAt ? 1 : 0
    if (aServed !== bServed) return aServed - bServed
    return b.generatedAt.getTime() - a.generatedAt.getTime()
  })
}

export async function getNotice(id: string, scope: ResolvedScope) {
  const notice = await prisma.notice.findUnique({ where: { id }, include: noticeInclude })
  if (!notice || !scope.propertyIds.includes(notice.propertyId)) return null
  return notice
}

/**
 * The notices a TENANT may see, for the portal.
 *
 * Scoped to their own leases and to notices actually SERVED - a notice
 * generated but not yet served is staff work in progress, and showing it
 * would both confuse the tenant and, worse, arguably constitute service
 * nobody intended to perform yet.
 */
export async function listTenantNotices(leaseIds: readonly string[]) {
  if (leaseIds.length === 0) return []
  return prisma.notice.findMany({
    where: { leaseId: { in: [...leaseIds] }, servedAt: { not: null } },
    select: {
      id: true,
      type: true,
      bodyText: true,
      servedAt: true,
      documentId: true,
      property: { select: { name: true, timezone: true } },
      deliveries: {
        where: { method: 'PORTAL' },
        select: { id: true, readAt: true },
        orderBy: { servedAt: 'asc' },
      },
    },
    orderBy: { servedAt: 'desc' },
  })
}
