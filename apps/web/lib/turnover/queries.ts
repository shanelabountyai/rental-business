import 'server-only'

import { daysToFill, turnCostCents } from '@rental/core/metrics'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { planTurn, type TurnPlan } from '@rental/core/turnover'
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
  /// `moveInAt` (or its agreed `startsOn`, once that day has arrived) on
  /// this unit, otherwise `asOf` (today) - see `daysVacantIsFinal` for
  /// which one this is.
  daysVacant: number
  /// True once a new tenancy has actually started - `daysVacant` is the
  /// turn's final number and will not move again. False means it is still
  /// counting.
  daysVacantIsFinal: boolean
  totalCostCents: number
  /// R-178. The sequenced plan - per-stage windows against the target date,
  /// which stage is waiting on which, and what is overdue. Derived on read,
  /// never stored (see `packages/core/turnover/schedule.ts`).
  plan: TurnPlan
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

  // Whichever lease starts this unit's NEXT tenancy - excludes the departing
  // lease itself (its own `startsOn` is in the past, but it is not what
  // closes this turn's clock).
  //
  // NO LONGER GATED ON `moveInAt` (R-172). That column had no writer
  // anywhere in the codebase, so this filter matched nothing and every turn
  // ever counted read "N days vacant and counting" for ever, however long
  // ago the unit was actually filled.
  //
  // What replaces it is a status denylist, NOT `activatedAt`: that column
  // looks like the exact "this tenancy went live" marker and all three
  // activation paths do write it, but no seed in `packages/db/prisma` ever
  // does - so gating on it would leave the demo (and any imported book of
  // business) reading the same never-ending clock this item exists to fix.
  // A denylist is also the safer polarity for a status enum that grows: a
  // status added after ACTIVE counts as a tenancy, which is right.
  const nextLease = await prisma.lease.findFirst({
    where: {
      unitId,
      id: { not: project.leaseId },
      status: { notIn: ['DRAFT', 'PENDING_SIGNATURE'] },
      startsOn: { gte: project.lease.moveOutAt },
    },
    orderBy: { startsOn: 'asc' },
    select: { moveInAt: true, startsOn: true },
  })

  const today = businessDate(asOf, timezone)

  // The recorded handover when there is one, otherwise the agreed start -
  // the same fallback `operatingReport` and the leasing funnel have always
  // used, and the reason a turn whose move-in walk nobody logged still
  // produces a final number. `moveInAt` is a real TIMESTAMP and `startsOn`
  // is a `@db.Date`, so they take different readers (R-042).
  const startedOn = nextLease
    ? nextLease.moveInAt != null
      ? businessDate(nextLease.moveInAt, timezone)
      : utcToBusinessDate(nextLease.startsOn)
    : null

  // ...and it only ENDS the vacancy once it has happened. A lease signed
  // today to start next month leaves this unit empty today; taking its
  // future `startsOn` would report a final days-vacant longer than the
  // real one, for a turn still running. A recorded `moveInAt` is in the
  // past by construction, so this only ever bites the fallback.
  const fill = daysToFill({
    vacatedOn: moveOutDate,
    filledOn: startedOn != null && startedOn <= today ? startedOn : null,
    asOf: today,
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
    plan: planTurn({
      moveOutDate,
      // `targetRentReadyDate` is a `@db.Date`, so `utcToBusinessDate` reads
      // it and no timezone may touch it (R-042).
      targetRentReadyDate: project.targetRentReadyDate
        ? utcToBusinessDate(project.targetRentReadyDate)
        : null,
      today,
      workOrders: project.workOrders.map((wo) => ({
        turnoverStage: wo.turnoverStage,
        status: wo.status,
      })),
    }),
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
