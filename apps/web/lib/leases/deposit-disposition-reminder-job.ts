import 'server-only'

import { businessDate, businessDaysBetween, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { createTask } from '@/lib/tasks/create.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'

// "Escalating reminders and a 50%-elapsed owner alert" (INSP-03, R-071).
//
// PULL, NOT PUSH, like every other window-watching job in this codebase:
// nothing FIRES when a deadline is half elapsed, a day just has to pass, so
// this asks daily whether that has become true since yesterday. Two
// thresholds, not a sliding scale: halfway (ROUTINE, once) and overdue
// (URGENT, once) - the same "flagged once, not every day inside the
// window" posture `renewal-window-job.ts` already established, and for the
// identical reason: this job keeps re-querying the same still-open
// dispositions every day until one is finalized.
const LOCAL_HOUR = 5

SCHEDULED_JOBS.push({
  type: 'deposit.disposition_reminder',
  localHour: LOCAL_HOUR,
  description:
    'Flags a deposit disposition halfway to its statutory deadline, and again once it is overdue (INSP-03).',
  run: async ({ propertyId, timezone, businessDate: today }) => {
    const deposits = await prisma.deposit.findMany({
      where: { propertyId, dispositionDueOn: { not: null }, dispositionSentAt: null },
      select: {
        id: true,
        leaseId: true,
        dispositionDueOn: true,
        lease: { select: { moveOutAt: true, unit: { select: { name: true } } } },
      },
    })

    let flagged = 0
    for (const deposit of deposits) {
      if (!deposit.lease.moveOutAt || !deposit.dispositionDueOn) continue

      // `moveOutAt` is a TIMESTAMP read through the property's zone;
      // `dispositionDueOn` is a `@db.Date` and must not go near one. Reading
      // the first with `utcToBusinessDate` (R-169) widened this window by a
      // day for every evening move-out, skewing halfway and overdue with it.
      const start = businessDate(deposit.lease.moveOutAt, timezone)
      const due = utcToBusinessDate(deposit.dispositionDueOn)
      const windowDays = businessDaysBetween(start, due)
      const elapsedDays = businessDaysBetween(start, today)
      const overdue = today > due
      const halfway = !overdue && windowDays > 0 && elapsedDays / windowDays >= 0.5
      if (!overdue && !halfway) continue

      const taskType = overdue ? 'deposit.disposition_overdue' : 'deposit.disposition_halfway'
      // The same "checked directly, not relying on createTask's daily key"
      // guard renewal-window-job.ts uses - this job can see the SAME
      // deposit as halfway (or overdue) for many days running, and must
      // flag it exactly once per threshold, not once per day.
      const alreadyFlagged = await prisma.task.findFirst({
        where: { type: taskType, subjectId: deposit.leaseId },
        select: { id: true },
      })
      if (alreadyFlagged) continue

      await createTask(prisma, {
        propertyId,
        type: taskType,
        subjectType: 'Lease',
        subjectId: deposit.leaseId,
        businessDate: today,
        priority: overdue ? 'URGENT' : 'ROUTINE',
        title: overdue
          ? `Deposit disposition OVERDUE (was due ${due}) — ${deposit.lease.unit.name}`
          : `Deposit disposition halfway to its deadline (due ${due}) — ${deposit.lease.unit.name}`,
      })
      flagged++
    }

    return { checked: deposits.length, flagged }
  },
})
