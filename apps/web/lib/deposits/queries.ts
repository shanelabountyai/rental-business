import 'server-only'

import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for deposit disposition (INSP-03, R-071).

/// The one Deposit on a lease, with everything a disposition screen needs -
/// its deductions (each carrying enough of its evidence to render and to
/// derive `isUnsupportedDeduction()`), and the lease/property/tenant facts
/// the letter and the finalize form both read.
export async function getDepositForLease(leaseId: string, scope: ResolvedScope) {
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      unitId: true,
      moveOutAt: true,
      noticeForwardingAddress: true,
      property: { select: { id: true, name: true, legalEntityId: true, addressLine1: true, timezone: true } },
      unit: { select: { name: true } },
      leaseTenants: {
        where: { isPrimary: true },
        take: 1,
        select: { tenant: { select: { firstName: true, lastName: true } } },
      },
      deposits: {
        select: {
          id: true,
          heldCents: true,
          receivedAt: true,
          dispositionDueOn: true,
          dispositionSentAt: true,
          forwardingAddress: true,
          appliedCents: true,
          refundedCents: true,
          noticeId: true,
          deductions: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              description: true,
              amountCents: true,
              estimatedAgeYears: true,
              usefulLifeYears: true,
              workOrder: { select: { id: true, scope: true } },
              inspectionItem: { select: { id: true, room: true, item: true } },
              evidence: {
                where: { deletedAt: null },
                select: { id: true, fileName: true },
              },
            },
          },
        },
        take: 1,
      },
    },
  })
  if (!lease || !scope.propertyIds.includes(lease.propertyId)) return null

  return lease
}

/// Work orders on the unit - candidates for "this deduction's real cost is
/// this repair" (evidence path one of three, INSP-03).
export async function workOrdersForUnit(unitId: string) {
  return prisma.workOrder.findMany({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, scope: true, invoiceCents: true, actualLaborCents: true, actualMaterialsCents: true },
  })
}

/// The unit's own move-out inspection items - candidates for "this
/// deduction's evidence is this condition photo" (evidence path two of
/// three). Only MOVE_OUT, not PRE_MOVE_OUT - the preliminary walkthrough is
/// not the evidence a disposition rests on.
export async function moveOutInspectionItemsForLease(leaseId: string) {
  const inspection = await prisma.inspection.findFirst({
    where: { leaseId, type: 'MOVE_OUT' },
    orderBy: { createdAt: 'desc' },
    select: {
      items: {
        orderBy: { order: 'asc' },
        select: { id: true, room: true, item: true, condition: true },
      },
    },
  })
  return inspection?.items ?? []
}
