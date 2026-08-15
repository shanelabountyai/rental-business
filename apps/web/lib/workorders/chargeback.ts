import 'server-only'

import { jobCostCents } from '@rental/core/workorders'
import { prisma } from '@rental/db'

// Everything the chargeback panel and the chargeback action both need to know
// (MAINT-07, R-031).
//
// SHARED BECAUSE THE ACTION MUST RE-DERIVE IT, not because the panel is
// expensive. The amount, the tenancy and the "has this already been billed"
// answer all arrive at the server a second time as form fields it must not
// trust; deriving them from the database on both paths is what makes the
// panel a convenience rather than the authority.

export interface ChargebackContext {
  status: string
  tenantCaused: boolean
  jobCostCents: number
  /// The tenancy to bill, resolved - see `resolveChargebackLease`.
  leaseId: string | null
  /// The person who pays. Null when there is a lease but nobody on it is set
  /// up to be billed, which is a different problem from having no lease.
  payer: { id: string; stripeCustomerId: string | null } | null
  tenant: { id: string; firstName: string; lastName: string; email: string | null; phone: string | null } | null
  existingChargeId: string | null
  /// What was ACTUALLY charged, which is not the job cost whenever a partial
  /// amount was billed - the common case. Reporting the job cost here would
  /// tell a PM the tenant was billed $412 when they were billed $150.
  existingAmountCents: number | null
  /// Photos and invoices hanging off the job or its ticket. The notice
  /// promises the tenant these, so it has to count the real ones.
  evidenceCount: number
  jobSummary: string
  addressLine1: string
  unitName: string
  propertyId: string
  timezone: string
  closedAt: Date | null
}

/**
 * Which tenancy a repair gets billed to.
 *
 * ==========================================================================
 * THE STRUCTURAL GAP THIS ITEM HAD TO CLOSE. A WorkOrder has no lease. It has
 * a nullable `ticketId`, pointing at a Ticket with a nullable `leaseId` — so
 * for a PM-raised job there is no path to a tenant at all, and for a
 * tenant-reported one the path can still be empty.
 *
 * TWO SOURCES, IN THIS ORDER, AND NO THIRD.
 *
 *   1. The ticket's own lease. Whoever reported it was living there when they
 *      reported it, and that is the tenancy the repair belongs to even if
 *      they have since moved out — billing the NEW tenant for the old one's
 *      damage is the worst outcome available here.
 *
 *   2. Failing that, the live lease on the unit. A PM-raised job on an
 *      occupied unit — a plumber called about a smell, no ticket — is a real
 *      case, and the current tenancy is the only defensible answer.
 *
 * If neither resolves, this returns null and the decision refuses. It does
 * NOT fall back to the most recent ended lease. That would be a guess about
 * who broke something, made by a query, on the strength of a date range.
 * ==========================================================================
 */
async function resolveChargebackLease(workOrder: {
  unitId: string
  ticket: { leaseId: string | null } | null
}): Promise<string | null> {
  if (workOrder.ticket?.leaseId) return workOrder.ticket.leaseId

  const live = await prisma.lease.findFirst({
    where: { unitId: workOrder.unitId, status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
    orderBy: { startsOn: 'desc' },
    select: { id: true },
  })
  return live?.id ?? null
}

export async function chargebackContext(workOrderId: string): Promise<ChargebackContext | null> {
  const workOrder = await prisma.workOrder.findUnique({
    where: { id: workOrderId },
    select: {
      id: true,
      status: true,
      tenantCaused: true,
      scope: true,
      unitId: true,
      propertyId: true,
      closedAt: true,
      actualLaborCents: true,
      actualMaterialsCents: true,
      invoiceCents: true,
      unit: { select: { name: true } },
      property: { select: { addressLine1: true, timezone: true } },
      ticket: {
        select: {
          id: true,
          leaseId: true,
          description: true,
          tenant: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          },
        },
      },
      chargebacks: { select: { id: true, amountCents: true }, take: 1 },
    },
  })
  if (!workOrder) return null

  const leaseId = await resolveChargebackLease(workOrder)

  const [payer, evidenceCount] = await Promise.all([
    leaseId
      ? prisma.leasePayer.findFirst({
          where: { leaseId, active: true },
          select: {
            id: true,
            stripeCustomerId: true,
            tenant: {
              select: { id: true, firstName: true, lastName: true, email: true, phone: true },
            },
          },
        })
      : Promise.resolve(null),
    prisma.document.count({
      where: {
        deletedAt: null,
        OR: [
          { workOrderId: workOrder.id },
          ...(workOrder.ticket ? [{ ticketId: workOrder.ticket.id }] : []),
        ],
      },
    }),
  ])

  return {
    status: workOrder.status,
    tenantCaused: workOrder.tenantCaused,
    // The SAME number the close panel showed, from the same core function —
    // invoice wins where present. Recomputing it any other way here would let
    // the ceiling on a chargeback drift from the cost the PM was looking at
    // when they decided it (D-42).
    jobCostCents: jobCostCents({
      actualLaborCents: workOrder.actualLaborCents,
      actualMaterialsCents: workOrder.actualMaterialsCents,
      invoiceCents: workOrder.invoiceCents,
    }),
    leaseId,
    payer: payer ? { id: payer.id, stripeCustomerId: payer.stripeCustomerId } : null,
    // The payer's tenant is who gets served, not the ticket's reporter — an
    // occupant can report a leak without being the person who pays.
    tenant: payer?.tenant ?? workOrder.ticket?.tenant ?? null,
    existingChargeId: workOrder.chargebacks[0]?.id ?? null,
    existingAmountCents: workOrder.chargebacks[0]?.amountCents ?? null,
    evidenceCount,
    // The tenant's own words where they exist, the internal scope otherwise.
    // A notice reading "R/R disposal, 1/2hp" is not a notice.
    jobSummary: workOrder.ticket?.description?.slice(0, 200) ?? workOrder.scope,
    addressLine1: workOrder.property.addressLine1,
    unitName: workOrder.unit.name,
    propertyId: workOrder.propertyId,
    timezone: workOrder.property.timezone,
    closedAt: workOrder.closedAt,
  }
}
