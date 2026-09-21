import 'server-only'

import { recordAudit } from '@rental/core/audit'
import { renewalRentCheck } from '@rental/core/leases'
import { formatCents } from '@rental/core/money'
import {
  UNREVIEWED_DAY_COUNT,
  businessDate as businessDateOf,
  businessDateToUtc,
  friendlyBusinessDate,
  utcToBusinessDate,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { syncLease } from '@/lib/billing/lifecycle.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { rulesForConfigured } from '@/lib/jurisdiction/queries.ts'
import { createTask } from '@/lib/tasks/create.ts'

// The rent-increase cutover (LEASE-09, R-225). A raise typed on the lease
// form is a `RentChange`, not a new `rentCents`; this is what finally writes
// it, on its own effective date, and only when the tenant was told in time.
//
// 03:00 local, before the 09:00 billing anchor (`billingCycleAnchor`), so a
// raise effective on a due day is on that day's invoice. Stripe prorates
// nothing (`proration_behavior: 'none'`), so a raise effective mid-period
// first bills on the next due day - later than it could have, never earlier.
//
// THE NOTICE IS JUDGED BY WHEN IT WAS SERVED, not when it was drafted. The
// form checked the period against the day staff typed it; a notice left
// unserved for two weeks gives two weeks less. Without a recorded override,
// the period is re-checked here from the real `servedAt` - the mistake review
// finding 7 found on the entry path, not repeated on this one.
const LOCAL_HOUR = 3

SCHEDULED_JOBS.push({
  type: 'lease.rent_change_cutover',
  localHour: LOCAL_HOUR,
  description:
    'Applies a scheduled rent increase on its effective date once its notice was served in time, or holds it and opens a task (LEASE-09).',
  run: async ({ propertyId, businessDate }) => {
    const due = await prisma.rentChange.findMany({
      where: { propertyId, status: 'SCHEDULED', effectiveOn: { lte: businessDateToUtc(businessDate) } },
      select: {
        id: true,
        leaseId: true,
        fromCents: true,
        toCents: true,
        effectiveOn: true,
        overrideReason: true,
        notice: { select: { servedAt: true } },
        lease: {
          select: {
            status: true,
            rentCents: true,
            property: { select: { timezone: true, state: true, county: true } },
          },
        },
      },
    })

    let applied = 0
    let held = 0
    for (const change of due) {
      const { lease } = change
      const effectiveOn = utcToBusinessDate(change.effectiveOn)
      const heldReason = await (async (): Promise<string | null> => {
        if (lease.status !== 'ACTIVE' && lease.status !== 'MONTH_TO_MONTH') {
          return 'The tenancy is no longer running.'
        }
        // Somebody changed the rent by hand since this was scheduled. Writing
        // `toCents` now would silently undo that edit.
        if (lease.rentCents !== change.fromCents) {
          return `The rent was changed to ${formatCents(lease.rentCents)} after this increase was scheduled.`
        }
        if (!change.notice.servedAt) return 'The rent increase notice was never served.'
        if (change.overrideReason) return null
        const servedOn = businessDateOf(change.notice.servedAt, lease.property.timezone)
        const rule = await rulesForConfigured(
          { state: lease.property.state, county: lease.property.county },
          change.notice.servedAt,
        )
        const decision = renewalRentCheck({
          currentRentCents: change.fromCents,
          proposedRentCents: change.toCents,
          effectiveOn,
          offeredOn: servedOn,
          rentIncreaseCapPercentBps: rule?.rentIncreaseCapPercentBps ?? null,
          rentIncreaseNoticeDays: rule?.rentIncreaseNoticeDays ?? null,
          dayCount: rule ?? UNREVIEWED_DAY_COUNT,
        })
        if (decision.blocked) {
          return `The increase exceeds the ${(decision.capPercentBps! / 100).toFixed(1)}% statutory cap in force when the notice was served.`
        }
        if (decision.needsOverride) {
          return `The notice was served on ${friendlyBusinessDate(servedOn)}, giving ${decision.noticeDaysGiven} of the ${decision.requiredNoticeDays} days required.`
        }
        return null
      })()

      if (heldReason) {
        await prisma.$transaction(async (tx) => {
          await tx.rentChange.update({
            where: { id: change.id },
            data: { status: 'HELD', heldReason },
          })
          await recordAudit(tx, {
            actor: { type: 'SYSTEM', ref: 'lease.rent_change_cutover' },
            action: 'lease.rent_increase_held',
            entityType: 'Lease',
            entityId: change.leaseId,
            propertyId,
            after: { rentChangeId: change.id, toCents: change.toCents, effectiveOn, heldReason },
          })
        })
        await createTask(prisma, {
          propertyId,
          type: 'rent_increase_held',
          subjectType: 'Lease',
          subjectId: change.leaseId,
          businessDate,
          priority: 'URGENT',
          title: `Rent increase to ${formatCents(change.toCents)} was not applied. ${heldReason} Re-issue it with a new date.`,
        })
        held++
        continue
      }

      await prisma.$transaction(async (tx) => {
        await tx.lease.update({ where: { id: change.leaseId }, data: { rentCents: change.toCents } })
        await tx.rentChange.update({
          where: { id: change.id },
          data: { status: 'APPLIED', appliedAt: new Date() },
        })
        await recordAudit(tx, {
          actor: { type: 'SYSTEM', ref: 'lease.rent_change_cutover' },
          action: 'lease.rent_increase_applied',
          entityType: 'Lease',
          entityId: change.leaseId,
          propertyId,
          before: { rentCents: change.fromCents },
          after: { rentCents: change.toCents, rentChangeId: change.id, effectiveOn },
        })
      })
      // The nightly billing run would also catch it; pushing now keeps the
      // gap between the lease and Stripe to minutes, not a night.
      await syncLease(change.leaseId).catch((error: unknown) => {
        console.error(`[lease] billing sync failed after rent increase ${change.id}`, error)
      })
      applied++
    }

    return { checked: due.length, applied, held }
  },
})
