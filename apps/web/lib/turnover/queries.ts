import 'server-only'

import { daysToFill, turnCostCents } from '@rental/core/metrics'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { jobCostCents } from '@rental/core/workorders'
import { prisma } from '@rental/db'

// Read side for the turnover panel (LEASE-12, R-072). One project at a
// time - the unit page's own EmptySection-replacement pattern shows the
// MOST RECENT turn for the unit, current or not, so a completed one is
// still visible (its cost roll-up, its punch list) until the next move-out
// starts a new one.

export interface TurnoverPunchListItem {
  id: string
  scope: string
  stage: string | null
  status: string
  priority: string
  vendorName: string | null
  assignedStaffName: string | null
  costCents: number
}

export interface TurnoverDetail {
  id: string
  propertyId: string
  unitId: string
  leaseId: string
  targetRentReadyDate: string | null
  rentReadyAt: Date | null
  moveOutDate: string
  /// Days from move-out to whichever ends the clock: the NEXT lease's
  /// `moveInAt` on this unit once one exists, otherwise `asOf` (today) -
  /// see `daysVacantIsFinal` for which one this is.
  daysVacant: number
  /// True once a new tenancy has actually started - `daysVacant` is the
  /// turn's final number and will not move again. False means it is still
  /// counting.
  daysVacantIsFinal: boolean
  totalCostCents: number
  items: TurnoverPunchListItem[]
}

export async function getTurnoverForUnit(
  unitId: string,
  timezone: string,
  asOf: Date,
): Promise<TurnoverDetail | null> {
  const project = await prisma.turnoverProject.findFirst({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
    include: {
      lease: { select: { moveOutAt: true } },
      workOrders: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          scope: true,
          turnoverStage: true,
          status: true,
          priority: true,
          actualLaborCents: true,
          actualMaterialsCents: true,
          invoiceCents: true,
          vendor: { select: { name: true } },
          assignedTo: { select: { name: true } },
        },
      },
    },
  })
  if (!project || !project.lease.moveOutAt) return null

  // Both `moveOutAt` and `moveInAt` are real TIMESTAMPS, so the property's
  // zone reads them - `utcToBusinessDate` is the `@db.Date` reader and put an
  // evening move-out on the next calendar day, shortening every turn's
  // `daysVacant` by one (R-169). `targetRentReadyDate` below IS a `@db.Date`.
  const moveOutDate = businessDate(project.lease.moveOutAt, timezone)

  // Whichever lease starts this unit's NEXT tenancy, once one has actually
  // moved in - excludes the departing lease itself (its own `startsOn` is
  // in the past, but it is not what closes this turn's clock).
  const nextLease = await prisma.lease.findFirst({
    where: {
      unitId,
      id: { not: project.leaseId },
      moveInAt: { not: null },
      startsOn: { gte: project.lease.moveOutAt },
    },
    orderBy: { startsOn: 'asc' },
    select: { moveInAt: true },
  })

  const fill = daysToFill({
    vacatedOn: moveOutDate,
    filledOn: nextLease?.moveInAt ? businessDate(nextLease.moveInAt, timezone) : null,
    asOf: businessDate(asOf, timezone),
  })

  return {
    id: project.id,
    propertyId: project.propertyId,
    unitId: project.unitId,
    leaseId: project.leaseId,
    targetRentReadyDate: project.targetRentReadyDate
      ? utcToBusinessDate(project.targetRentReadyDate)
      : null,
    rentReadyAt: project.rentReadyAt,
    moveOutDate,
    daysVacant: fill.days,
    daysVacantIsFinal: fill.isFinal,
    totalCostCents: turnCostCents(project.workOrders),
    items: project.workOrders.map((wo) => ({
      id: wo.id,
      scope: wo.scope,
      stage: wo.turnoverStage,
      status: wo.status,
      priority: wo.priority,
      vendorName: wo.vendor?.name ?? null,
      assignedStaffName: wo.assignedTo?.name ?? null,
      costCents: jobCostCents(wo),
    })),
  }
}
