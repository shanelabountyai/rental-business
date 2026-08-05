import 'server-only'

import type { TenantScope } from '@rental/core/portal'
import { prisma } from '@rental/db'

// Reads for the tenant maintenance flow (MAINT-01, R-019).

/**
 * The property, unit and lease a maintenance request should attach to: the
 * tenant's most recent lease.
 *
 * Returns null for a tenant with no lease on file - an applicant, or a
 * record created ahead of a tenancy. There is no unit to file a request
 * against, so the wizard says so rather than letting the flow proceed toward
 * a Ticket with nothing to scope it to.
 */
export async function getTenantCurrentHome(scope: TenantScope) {
  if (scope.leaseIds.length === 0) return null

  return prisma.lease.findFirst({
    where: { id: { in: [...scope.leaseIds] } },
    orderBy: { startsOn: 'desc' },
    select: { id: true, propertyId: true, unitId: true },
  })
}

/// This tenant's own maintenance requests (DOC-03's "only mine" pattern,
/// applied here even though Ticket carries no privileged data - a tenant's
/// list of what they have reported is still their own record, scoped the
/// same way as everything else in the portal).
export async function listTenantTickets(scope: TenantScope) {
  return prisma.ticket.findMany({
    where: { tenantId: scope.tenantId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      category: true,
      status: true,
      priority: true,
      createdAt: true,
    },
  })
}

/// One ticket, or null if it is not theirs - see listTenantTickets and
/// DOC-03's "not yours and does not exist must be indistinguishable" rule,
/// applied identically here.
export async function getTenantTicket(id: string, scope: TenantScope) {
  return prisma.ticket.findFirst({
    where: { id, tenantId: scope.tenantId },
    include: {
      documents: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, fileName: true, contentType: true, createdAt: true },
      },
    },
  })
}
