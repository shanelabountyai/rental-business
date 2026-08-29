import 'server-only'

import { addBusinessDays, friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { createTask } from '@/lib/tasks/create.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'

// Lead-time alerts, and an overdue escalation once the date passes
// (PROP-05, R-077). Two thresholds, not a sliding scale - the same
// "flagged once, not every day inside the window" shape
// `deposit-disposition-reminder-job.ts` (R-071) already established.
//
// ENTITY-LEVEL ITEMS ARE NATURALLY DEDUPED, NOT SPECIAL-CASED. This job
// runs once per PROPERTY (`SCHEDULED_JOBS`' own shape), so an entity-level
// item spanning three properties gets checked three times a day - but
// `subjectId` on the Task is the compliance item's own id, and the
// "already flagged" check below reads by that id, so the second and third
// property's own run each see a Task that already exists and skip. No
// "canonical property" concept needed.
const LOCAL_HOUR = 6

SCHEDULED_JOBS.push({
  type: 'compliance.item_due',
  localHour: LOCAL_HOUR,
  description:
    "Flags a compliance item once it enters its own lead-time window, and again once it is overdue (PROP-05).",
  run: async ({ propertyId, businessDate: today }) => {
    const property = await prisma.property.findUniqueOrThrow({
      where: { id: propertyId },
      select: { legalEntityId: true },
    })

    const items = await prisma.complianceItem.findMany({
      where: {
        OR: [{ propertyId }, { legalEntityId: property.legalEntityId }],
      },
      select: {
        id: true,
        type: true,
        label: true,
        dueOn: true,
        leadTimeDays: true,
        recurrenceMonths: true,
        completions: { take: 1, select: { id: true } },
      },
    })

    let flagged = 0
    for (const item of items) {
      // A satisfied one-time item is done for good - `dueOn` never moves
      // for one, so without this check it would alert forever.
      if (item.recurrenceMonths == null && item.completions.length > 0) continue

      const dueDate = utcToBusinessDate(item.dueOn)
      const overdue = today > dueDate
      const leadStart = addBusinessDays(dueDate, -item.leadTimeDays)
      const inLeadWindow = !overdue && today >= leadStart

      if (!overdue && !inLeadWindow) continue

      const taskType = overdue ? 'compliance.item_overdue' : 'compliance.item_due_soon'
      const alreadyFlagged = await prisma.task.findFirst({
        where: { type: taskType, subjectId: item.id },
        select: { id: true },
      })
      if (alreadyFlagged) continue

      await createTask(prisma, {
        propertyId,
        type: taskType,
        subjectType: 'ComplianceItem',
        subjectId: item.id,
        businessDate: today,
        priority: overdue ? 'URGENT' : 'ROUTINE',
        title: overdue
          ? `Compliance item OVERDUE (was due ${friendlyBusinessDate(dueDate)}) — ${item.label}`
          : `Compliance item due ${friendlyBusinessDate(dueDate)} — ${item.label}`,
      })
      flagged++
    }

    return { checked: items.length, flagged }
  },
})
