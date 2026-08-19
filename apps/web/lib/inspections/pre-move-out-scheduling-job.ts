import 'server-only'

import { addBusinessDays, businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { itemsFromMoveIn } from '@/lib/inspections/move-out-copy.ts'
import { createTask } from '@/lib/tasks/create.ts'

// "Given a state granting a pre-move-out walkthrough right, when a move-out
// is scheduled, then the pre-inspection with itemized fixable list is
// calendared automatically" (INSP-02, R-070).
//
// A MOVE-OUT IS "SCHEDULED" THE MOMENT A LEASE'S OWN `noticeEffectiveOn` IS
// SET - R-066 already writes that column, for either party's notice
// (tenant's own notice to vacate, or the owner's non-renewal), and it IS
// the move-out date: no separate "move-out scheduled" fact exists or needs
// to.
//
// PULL, NOT PUSH, like every other window-watching job in this file
// (`renewal-window-job.ts`, `deposit-clearing-job.ts`): whether a state
// grants this right is JurisdictionRule configuration a job has to re-check
// daily rather than react to an event, since the right itself never
// "happens" - only the notice does.
const LOCAL_HOUR = 4

SCHEDULED_JOBS.push({
  type: 'inspection.pre_move_out_scheduled',
  localHour: LOCAL_HOUR,
  description:
    "Auto-schedules a PRE_MOVE_OUT walkthrough, copied from the lease's own move-in checklist, once a state-granted right applies to a lease under notice (INSP-02).",
  run: async ({ propertyId, businessDate: today }) => {
    const property = await prisma.property.findUniqueOrThrow({
      where: { id: propertyId },
      select: { state: true, county: true },
    })
    // No rule on file at all, or the right simply not reviewed for this
    // state yet, both read the same way here: nothing is scheduled. Neither
    // is an error - see JurisdictionRuleNotFoundError's own comment and the
    // schema's "null means unreviewed" posture on this column.
    const rule = await rulesFor(property, new Date()).catch(() => null)
    if (!rule?.preMoveOutWalkthroughRequired) return { checked: 0, scheduled: 0 }
    const daysBefore = rule.preMoveOutWalkthroughDaysBefore ?? 0

    const leases = await prisma.lease.findMany({
      where: {
        propertyId,
        noticeGivenAt: { not: null },
        noticeEffectiveOn: { not: null },
        status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] },
        // Idempotent per lease, not per day - once scheduled it is never
        // scheduled again, even if the job keeps running every day the
        // notice window is open (renewal-window-job.ts's own reasoning for
        // why createTask's daily key alone is not enough here either).
        inspections: { none: { type: 'PRE_MOVE_OUT' } },
      },
      select: {
        id: true,
        unitId: true,
        noticeEffectiveOn: true,
        unit: { select: { name: true } },
      },
    })

    let scheduled = 0
    for (const lease of leases) {
      const moveOutDate = utcToBusinessDate(lease.noticeEffectiveOn!)
      const target = addBusinessDays(moveOutDate, -daysBefore)
      // Never scheduled into the past - a short notice period can put the
      // computed date behind today, and the walkthrough still needs to
      // happen, just as soon as possible rather than never.
      const scheduledFor = target < today ? today : target

      const copy = await itemsFromMoveIn(prisma, lease.id)

      await prisma.$transaction(async (tx) => {
        const created = await tx.inspection.create({
          data: {
            propertyId,
            unitId: lease.unitId,
            leaseId: lease.id,
            type: 'PRE_MOVE_OUT',
            scheduledFor: businessDateToUtc(scheduledFor),
            items: { create: copy?.items ?? [] },
          },
        })
        await auditAsSystem(
          'inspection.pre_move_out_scheduled',
          {
            action: 'inspection.created',
            entityType: 'Inspection',
            entityId: created.id,
            propertyId,
            after: {
              type: 'PRE_MOVE_OUT',
              scheduledFor,
              copiedFromInspectionId: copy?.sourceInspectionId ?? null,
              itemCount: copy?.items.length ?? 0,
            },
          },
          tx,
        )
        await createTask(tx, {
          propertyId,
          type: 'inspection.pre_move_out_scheduled',
          subjectType: 'Lease',
          subjectId: lease.id,
          businessDate: today,
          priority: 'ROUTINE',
          title: `Pre-move-out walkthrough due ${scheduledFor} — ${lease.unit.name}`,
        })
      })
      scheduled++
    }

    return { checked: leases.length, scheduled }
  },
})
