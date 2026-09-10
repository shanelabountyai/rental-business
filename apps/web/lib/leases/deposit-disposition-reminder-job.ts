import 'server-only'

import {
  businessDate,
  businessDaysBetween,
  friendlyBusinessDate,
  utcToBusinessDate,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { alreadyFlagged } from '@/lib/tasks/already-flagged.ts'
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
      where: {
        propertyId,
        dispositionDueOn: { not: null },
        // R-188: THE LETTER DOES NOT STOP THE CLOCK. Texas §92.103 runs the
        // itemization and the refund on ONE deadline, so a finalized
        // disposition that still owes money is still inside the window this
        // job watches - it was silent from `dispositionSentAt` onward, which
        // is the moment the obligation to pay actually begins. Keyed on
        // `refundPaidOn`, exactly as the liability itself is (R-170's schema
        // comment): the money leaving is the only thing that closes it.
        OR: [{ dispositionSentAt: null }, { refundPaidOn: null, refundedCents: { gt: 0 } }],
      },
      select: {
        id: true,
        dispositionDueOn: true,
        dispositionSentAt: true,
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
      const owed = deposit.dispositionSentAt ? 'Deposit refund' : 'Deposit disposition'
      // The same "checked directly, not relying on createTask's daily key"
      // guard renewal-window-job.ts uses - this job can see the SAME
      // deposit as halfway (or overdue) for many days running, and must
      // flag it exactly once per threshold, not once per day.
      //
      // R-191: KEYED ON THE DEPOSIT, NOT THE LEASE. R-188 left this as
      // `deposit.leaseId`, so a lease holding a SECURITY and a PET deposit
      // flagged once for both - the second deposit's own statutory clock had
      // no row anywhere. The subject is the deposit, which is also what
      // `finalizeDisposition`'s `deposit_refund_due` Task already uses
      // (D-174), so the two rows watching one deadline now agree on what
      // they are about.
      if (await alreadyFlagged(taskType, deposit.id, today)) continue

      await createTask(prisma, {
        propertyId,
        type: taskType,
        subjectType: 'Deposit',
        subjectId: deposit.id,
        businessDate: today,
        priority: overdue ? 'URGENT' : 'ROUTINE',
        // Same clock, different outstanding act: before the letter the
        // owner still owes an itemization, after it they owe the cheque.
        // Naming the wrong one is how a queue stops being read.
        // D-153: `due` is a BusinessDate and must be RENDERED, never
        // interpolated - these two titles read "was due 2026-09-30" in the
        // one urgent queue an operator is meant to act off.
        title: overdue
          ? `${owed} OVERDUE (was due ${friendlyBusinessDate(due)}) — ${deposit.lease.unit.name}`
          : `${owed} halfway to its deadline (due ${friendlyBusinessDate(due)}) — ${deposit.lease.unit.name}`,
      })
      flagged++
    }

    return { checked: deposits.length, flagged }
  },
})
