import 'server-only'

import { OPEN_TICKET_STATUSES } from '@rental/core/comms'
import type { TenantScope } from '@rental/core/portal'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for the maintenance module: the tenant flow (MAINT-01, R-019) above,
// staff-side reads (R-022) below.

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
      // The tenant reads "reported on the 14th" in the timezone of the house
      // they live in, not the server's (R-101c). Without this column the date
      // was formatted in UTC, so an evening report showed as the next day.
      property: { select: { timezone: true } },
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
      // R-030: the work orders behind this request, so the portal can ask
      // "is it fixed?" the moment one reaches WORK_COMPLETE. Verifications
      // ride along because whether we have ALREADY been answered is what
      // decides between showing the question and showing the thanks.
      workOrders: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          reopenCount: true,
          verifications: { orderBy: { round: 'desc' }, take: 1 },
        },
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Staff reads (R-022). Scoped by ResolvedScope, same as R-011's task queue
// and R-008's property list - the switcher's selection, already intersected
// with RBAC.
// ---------------------------------------------------------------------------

const OPEN_STATUSES = [...OPEN_TICKET_STATUSES]

const staffTicketInclude = {
  // timezone: a ticket's date is rendered in the PROPERTY's zone, not the
  // server's (R-101c). Cheap column on a row already being fetched.
  property: { select: { id: true, name: true, timezone: true } },
  unit: { select: { id: true, name: true } },
  tenant: { select: { id: true, firstName: true, lastName: true, phone: true } },
  // R-029's emergency panel: who took responsibility, and when. Cheap
  // columns on a row already being fetched.
  acknowledgedBy: { select: { name: true } },
} as const

/// A bare list, sorted newest first - the full triage queue (priority
/// override, merge, SLA timer) is R-023's. This exists so a logged phone
/// request is actually visible somewhere and reachable by id, and so every
/// ticket source (portal, SMS, phone-logged) already lands in one place
/// before R-023 builds the real workflow on top.
export async function listOpenTickets(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  return prisma.ticket.findMany({
    where: { propertyId: { in: scope.propertyIds }, status: { in: OPEN_STATUSES } },
    orderBy: { createdAt: 'desc' },
    include: staffTicketInclude,
  })
}

export async function getStaffTicket(id: string, scope: ResolvedScope) {
  const ticket = await prisma.ticket.findUnique({
    where: { id },
    include: staffTicketInclude,
  })
  if (!ticket || !scope.propertyIds.includes(ticket.propertyId)) return null
  return ticket
}

/// Every active lease's tenant, in scope - the picker for "who is this call
/// about". One option per LeaseTenant rather than per Lease, so a lease with
/// more than one tenant on it offers each by name instead of forcing staff
/// to guess which one called.
export async function listLoggableLeaseTenants(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  return prisma.leaseTenant.findMany({
    where: {
      lease: { propertyId: { in: scope.propertyIds }, status: 'ACTIVE' },
      tenant: { active: true },
    },
    select: {
      id: true,
      tenantId: true,
      isPrimary: true,
      tenant: { select: { firstName: true, lastName: true, phone: true } },
      lease: {
        select: {
          id: true,
          unitId: true,
          property: { select: { id: true, name: true, timezone: true } },
          unit: { select: { name: true } },
        },
      },
    },
    orderBy: [{ lease: { property: { name: 'asc' } } }, { isPrimary: 'desc' }],
  })
}
