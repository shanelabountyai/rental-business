import 'server-only'

import { addBusinessDays, type BusinessDate, businessDateToUtc } from '@rental/core/scheduling'
import { prisma, TaskStatus } from '@rental/db'

// The one "have we already raised this?" guard every window-watching job
// uses (R-191). Six jobs each hand-wrote `findFirst({ where: { type,
// subjectId } })` and all six had the same hole: NO STATUS FILTER, so a Task
// somebody marked DONE or CANCELED still matched and the condition could
// never raise a second one for the life of the subject.
//
// R-158's rule that produced that shape is still right - a case stalled for
// a month must give one Task, not thirty - but "once ever" is not what it
// asked for. Two clauses instead:
//
//   An OPEN/IN_PROGRESS/BLOCKED Task means somebody is still holding this
//   one. Never raise a second, at any age.
//
//   A CLOSED Task suppresses only until its own business date plus the
//   cool-off. Past that, if the condition STILL holds, the queue says so
//   again - because a Task closed without the condition changing is exactly
//   the case that used to go silent for ever.
//
// The sharpest instance is `accommodation.response_overdue`: EMERGENCY,
// because D-89 says an unanswered request reads as denied, and one Task
// ticked off without deciding the request silenced the escalation for the
// life of that request. The dullest is a RECURRING `ComplianceItem` - its
// `dueOn` advances on completion (compliance/actions.ts), so next year's
// inspection was never going to be flagged at all.
//
// `createTask` is already idempotent on (type, subjectId, businessDate), so
// this is not what stops a double-fire inside one day; it is what stops a
// daily nag across a long window.

/// Somebody still has this one. Not a re-raise candidate at any age.
const HELD_STATUSES = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED]

/**
 * Days a CLOSED flag keeps suppressing a re-raise, measured from that flag's
 * own business date.
 *
 * One number for every caller, deliberately: the do-not-build list for this
 * arc (D-201) refuses a settings screen for thresholds like this one, and a
 * week is the interval at which a queue entry reads as a reminder rather
 * than as noise. It only ever applies after a human closed the Task without
 * the underlying condition changing.
 */
export const TASK_REFLAG_COOL_OFF_DAYS = 7

export async function alreadyFlagged(
  type: string,
  subjectId: string,
  today: BusinessDate,
  coolOffDays = TASK_REFLAG_COOL_OFF_DAYS,
): Promise<boolean> {
  const coolOffFloor = businessDateToUtc(addBusinessDays(today, -coolOffDays))
  const existing = await prisma.task.findFirst({
    where: {
      type,
      subjectId,
      OR: [{ status: { in: HELD_STATUSES } }, { businessDate: { gt: coolOffFloor } }],
    },
    select: { id: true },
  })
  return existing != null
}
