import 'server-only'

import { resolvePolicy } from '@rental/core/approvals'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import { getOperationalData } from '@/lib/operational/queries.ts'

/**
 * The entity's policy for a work order, resolved through its property.
 *
 * Read fresh on every decision rather than captured when the work order was
 * created: an owner who tightens their threshold means it from now on, and a
 * stale copy would let already-open work orders through under the old number.
 *
 * Lives here rather than in approvals.ts because closeWorkOrder needs it too
 * and approvals.ts is `'use server'` - exporting it from there would publish
 * a policy lookup as a client-callable endpoint.
 */
export async function policyFor(propertyId: string) {
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { legalEntity: true },
  })
  return resolvePolicy(property.legalEntity)
}

// Reads for work orders (MAINT-03, PROP-06, R-024). Scoped by ResolvedScope,
// the same switcher-intersected-with-RBAC pattern R-022's maintenance
// queries and R-011's task queue already use.

/**
 * Everything that is still somebody's problem.
 *
 * `VERIFIED` IS OPEN. The tenant confirming the repair is not the end of the
 * job - the invoice usually has not arrived, nothing has been booked, and
 * `CLOSED` is a decision a PM makes with a number in front of them. Leaving
 * it out (as this list originally did) made the tenant's one tap delete the
 * work order from every screen: off this list, absent from
 * `closedJobCostsForProperty` which filters `CLOSED`, and reachable only by
 * typing its URL. The money still to be recorded went with it.
 */
const OPEN_STATUSES = [
  'SUBMITTED',
  'TRIAGED',
  'PENDING_APPROVAL',
  'APPROVED',
  'ASSIGNED',
  'SCHEDULED',
  'IN_PROGRESS',
  'WORK_COMPLETE',
  'VERIFIED',
  'ON_HOLD_WARRANTY',
  'WAITING_ON_TENANT',
] as const

const workOrderInclude = {
  // state/county are here for R-027's entry-notice lookup (rulesFor()),
  // which every work order detail view now does. Cheap columns on a row
  // already being fetched, versus a second query per page.
  property: {
    select: {
      id: true,
      name: true,
      timezone: true,
      legalEntityId: true,
      state: true,
      county: true,
      addressLine1: true,
    },
  },
  unit: { select: { id: true, name: true } },
  // tenant email/phone: R-032's reply-to-tenant form needs to know which
  // channels are actually reachable, cheap columns on a row already being
  // fetched rather than a second query per page.
  ticket: {
    select: {
      id: true,
      category: true,
      description: true,
      tenantId: true,
      tenant: { select: { email: true, phone: true, firstName: true, lastName: true } },
    },
  },
  vendor: { select: { id: true, name: true, phone: true, email: true } },
  assignedTo: { select: { id: true, name: true } },
} as const

export async function listOpenWorkOrders(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  return prisma.workOrder.findMany({
    where: { propertyId: { in: scope.propertyIds }, status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: 'desc' },
    include: workOrderInclude,
  })
}

export async function getWorkOrder(id: string, scope: ResolvedScope) {
  const workOrder = await prisma.workOrder.findUnique({
    where: { id },
    include: workOrderInclude,
  })
  if (!workOrder || !scope.propertyIds.includes(workOrder.propertyId)) return null
  return workOrder
}

/// Every non-expired-by-default warranty on the property (packages/core's
/// own isWarrantyActive filters, given expiresOn treats null as "unknown,"
/// not "safe to ignore") - the create-work-order form's own job, not this
/// query's, to decide what counts as active right now.
export async function warrantiesForProperty(propertyId: string) {
  return prisma.warranty.findMany({
    where: { propertyId },
    orderBy: { category: 'asc' },
  })
}

/// Staff who hold workorder.write over a property, through any live
/// assignment - the in-house assignment picker. Same shape as
/// notifications/consumers.ts's own staffForProperty and
/// maintenance/emergency.ts's onCallStaffForProperty; not shared with
/// either because each answers a different permission's inverse question.
export async function staffForWorkOrderAssignment(propertyId: string) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { legalEntityId: true },
  })
  if (!property) return []

  const assignments = await prisma.staffAssignment.findMany({
    where: {
      revokedAt: null,
      staffUser: { active: true },
      role: { permissions: { has: 'workorder.write' } },
      OR: [
        { propertyId: null, legalEntityId: null },
        { legalEntityId: property.legalEntityId },
        { propertyId },
      ],
    },
    select: { staffUser: { select: { id: true, name: true } } },
  })

  const byId = new Map<string, { id: string; name: string }>()
  for (const assignment of assignments) {
    byId.set(assignment.staffUser.id, assignment.staffUser)
  }
  return [...byId.values()]
}

/// Every unit in scope, for the standalone-creation picker (no ticket, so
/// no lease/tenant context to derive it from the way R-022's phone-log
/// picker does).
export async function unitsInScope(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  return prisma.unit.findMany({
    where: { propertyId: { in: scope.propertyIds } },
    select: { id: true, name: true, property: { select: { id: true, name: true, timezone: true } } },
    orderBy: [{ property: { name: 'asc' } }, { name: 'asc' }],
  })
}

/// Active vendors, for the assignment picker. A 10-50 unit portfolio's own
/// vendor list is short enough to show whole and let the PM read trades off
/// each row - not a query built for a row count this scale will never see.
export async function activeVendors() {
  return prisma.vendor.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
  })
}

/**
 * "Full context" MAINT-03 asks the in-house job list to carry: photos,
 * appliance data, filter sizes, codes, tenant phone. Reuses R-014's own
 * getOperationalData() for the appliance/access-code/utility/shutoff half
 * rather than re-querying those four tables here.
 */
export async function jobContextForWorkOrder(
  workOrder: { id: string; propertyId: string; unitId: string; ticketId: string | null },
  scope: ResolvedScope,
) {
  const [operational, photos, tenantPhone] = await Promise.all([
    getOperationalData(workOrder.propertyId, workOrder.unitId, scope),
    prisma.document.findMany({
      where: {
        deletedAt: null,
        OR: [
          { workOrderId: workOrder.id },
          ...(workOrder.ticketId ? [{ ticketId: workOrder.ticketId }] : []),
        ],
      },
      select: { id: true, fileName: true, contentType: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    workOrder.ticketId
      ? prisma.ticket
          .findUnique({
            where: { id: workOrder.ticketId },
            select: { tenant: { select: { phone: true } } },
          })
          .then((t) => t?.tenant?.phone ?? null)
      : Promise.resolve(null),
  ])

  return { operational, photos, tenantPhone }
}
